import type { CanvasEvent, ContainerPoller, DeployService, DeployTarget } from "@/pages/deploy/deploy.socket";
import type { EdgeService } from "@/pages/edge/edge.socket";
import type { ProjectService } from "@/pages/projects/projects.socket";
import type { ServerService } from "@/pages/servers/servers.socket";
import type { CanvasService } from "./canvas.service";
import type { BoardModel, CardModel, DiscoveredContainer } from "./canvas.model";
import { discoverContainers } from "./domain/discovery";
import { clampCardX, violatesLane } from "./domain/zones";

/** /board 请求路径上的 docker 探测上限：半死的 SSH 中继没有自带超时，不能把整张画布挂住 */
const PROBE_TIMEOUT_MS = 5_000;
/** 探测失败时的上一轮发现层快照（serverId → 容器）：失败不清空发现卡，与轮询器同策略 */
const lastDiscovered = new Map<number, DiscoveredContainer[]>();

/** 超时竞速；超时后原 promise 的失败也要接住，避免变成 unhandled rejection */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  p.catch(() => { });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("docker 探测超时")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 卡片移动的裁决结果：服务层不抛 HTTP 语义，由 actions 翻译成状态码 */
export type MoveNodeResult =
  | { ok: true }
  | { ok: false; error: string };

/** 移动/resize 的入参契约由 CanvasService 派生，不重抄一份 */
type NodePatch = Parameters<CanvasService["moveNode"]>[1];

/**
 * canvas 页面的组合根（中间者）。
 *
 * 本原子只存节点/分组；看板要的服务器、部署、域名、项目信息在这里拼装。
 * 它依赖 canvas / deploy / server / project / edge / containerPoller，**没有任何服务依赖它**
 * → 服务键级图上的叶子节点，因此不构成回边。
 *
 * actions 只调本服务，不跨原子 di.get：窄类型 CanvasServices 由 di 声明自动包含这些依赖。
 */
export class BoardService {
  constructor(
    private readonly canvas: CanvasService,
    private readonly deploy: DeployService,
    private readonly server: ServerService,
    private readonly project: ProjectService,
    private readonly edge: EdgeService,
    private readonly poller: ContainerPoller,
  ) { }

  // ── 项目解析（client 壳用） ──

  /** 项目下拉：只给 id/name */
  async projects(): Promise<{ id: number; name: string }[]> {
    return (await this.project.list()).map((p) => ({ id: p.id, name: p.name }));
  }

  /** 缺省项目：最近一个；无 → undefined（actions 翻成 404） */
  async latestProjectId(): Promise<number | undefined> {
    return (await this.project.list()).at(-1)?.id;
  }

  /** 本地项目行点击：按路径幂等落库 */
  async resolveLocal(localPath: string): Promise<number> {
    return (await this.project.ensureLocal(localPath)).id;
  }

  // ── 看板数据 ──

  /**
   * 世界地图：无项目边界，返回全部服务器卡；target 的项目归属逐个补齐。
   * 部署侧的视图整形（连接串解密、compose 清单、依赖边）在 DeployService。
   */
  async board(): Promise<BoardModel> {
    const [nodes, servers, projects] = await Promise.all([
      this.canvas.nodesAll(),
      this.server.list(),
      this.project.list(), // 一次 list 建 Map，避免按 target 逐个查（N+1）
    ]);
    const byId = new Map(servers.map((s) => [s.id, s]));
    const projectNameOf = new Map(projects.map((p) => [p.id, p.name]));
    const rawTargets = new Map<number, DeployTarget>(); // 依赖边派生用（edgesOfTarget 要原始行）

    // 逐服务器卡并行组装：docker 探测串行时，一台 SSH 半死的服务器会拖死整个 /board
    const cards = (
      await Promise.all(
        nodes.map(async (node): Promise<CardModel | null> => {
          const server = byId.get(node.serverId);
          if (!server) return null;
          const targets = [];
          for (const target of await this.deploy.targetsOfNode(node.id)) {
            rawTargets.set(target.id, target);
            // app 的域名绑定（edge 反代 + 证书状态徽章）；serviceName 用于下沉到 compose 服务行
            const domains =
              target.kind === "app"
                ? (await this.edge.domainsOfTarget(target.id)).map((d) => ({
                  hostname: d.hostname,
                  sslStatus: d.sslStatus,
                  dnsStatus: d.dnsStatus,
                  serviceName: d.serviceName,
                  targetPort: d.targetPort,
                }))
                : [];
            // compose 服务清单（创建落库/存量惰性补全）；容器状态在下方按服务器聚合后填入
            const svcDoc =
              target.kind === "app"
                ? await this.deploy.servicesOfTarget(target)
                : { project: null, services: [] };
            targets.push({
              id: target.id,
              kind: target.kind,
              name: target.name,
              projectId: target.projectId ?? 0, // 0 = 未关联项目
              projectName:
                (target.projectId && projectNameOf.get(target.projectId)) || "",
              logical: Boolean(target.instanceOf),
              url: this.deploy.logicalUrlOf(target), // 逻辑库连接串（复制按钮）
              // 归属到具体服务的域名下沉到服务行；无归属的留 target 顶部
              domains: domains.filter(
                (d) =>
                  !d.serviceName ||
                  !svcDoc.services.some((s) => s.name === d.serviceName),
              ),
              services: svcDoc.services.map((s) => ({
                ...s,
                domains: domains.filter((d) => d.serviceName === s.name),
                ...(target.serviceLayout?.[s.name] ?? {}),
              })),
              edges: [], // 下方知道全部 target 名字后回填
              groupId: target.groupId,
              x: target.x,
              y: target.y,
              w: target.w,
              h: target.h,
              updateAvailable: target.updateAvailable,
              artifactShipped: target.artifactShipped,
            });
          }
          const {
            id,
            name,
            user,
            host,
            port,
            dockerStatus,
            dockerVersion,
            builtin,
          } = server;
          const groups = (await this.canvas.groupsOf(node.id)).map((g) => ({
            id: g.id,
            name: g.name,
            x: g.x,
            y: g.y,
            w: g.w,
            h: g.h,
          }));
          // 发现层（只读）：docker 里非 dockyard 管理的容器。
          // 未检测/daemon 不可用 → 空；探测失败（超时/断线）→ 沿用上一轮快照，
          // 不能把发现卡静默清空（轮询器对失败也是保持上轮快照）。
          let discovered: DiscoveredContainer[] = [];
          if (dockerStatus === "ok") {
            try {
              // 连 SSH + 列容器整体限时：sshPool 的建连超时是 30s，只包 listContainers 挡不住
              discovered = await withTimeout(
                (async () => {
                  const docker = await this.server.docker(server.id);
                  return discoverContainers(
                    await docker.listContainers({ all: true }),
                    projects,
                  );
                })(),
                PROBE_TIMEOUT_MS,
              );
              lastDiscovered.set(server.id, discovered);
            } catch {
              discovered = lastDiscovered.get(server.id) ?? [];
            }
          }
          return {
            node: { id: node.id, x: node.x, y: node.y, w: node.w, h: node.h },
            server: {
              id,
              name,
              user,
              host,
              port,
              dockerStatus,
              dockerVersion,
              local: builtin,
            },
            targets,
            groups,
            discovered,
          };
        }),
      )
    ).filter((c): c is CardModel => c !== null);
    // 服务器已删除 → 清掉快照，避免 serverId 复用后把旧容器挂到新服务器上
    for (const id of lastDiscovered.keys())
      if (!byId.has(id)) lastDiscovered.delete(id);
    // 服务级依赖边（client 派生 React Flow 边）；存量 dependsOn 由门面惰性派生为 service=null 的边
    const nameOfTarget = new Map<number, string>();
    for (const c of cards)
      for (const t of c.targets) nameOfTarget.set(t.id, t.name);
    for (const c of cards)
      for (const t of c.targets) {
        const raw = rawTargets.get(t.id);
        if (!raw) continue;
        t.edges = this.deploy.edgesOfTarget(raw).map((e) => ({
          service: e.service,
          db: e.db,
          dbName: nameOfTarget.get(e.db) ?? `#${e.db}`,
          origin: e.origin ?? "manual",
        }));
      }
    return {
      servers: servers.map(({ id, name }) => ({ id, name })),
      cards,
    };
  }

  /** SSE 首帧快照：部署状态 + 容器状态全量（订阅即齐，不等下轮 diff） */
  async snapshot(): Promise<CanvasEvent[]> {
    return [...(await this.deploy.statusSnapshot()), ...this.poller.statesAll()];
  }

  // ── 节点布局（车道规则需要服务器归属） ──

  /** 建卡：落点钳进该服务器的车道 */
  async addNode(serverId: number, x: number, y: number) {
    const server = await this.server.byId(serverId);
    return this.canvas.addNode(serverId, server ? clampCardX(server.builtin, x, 320) : x, y);
  }

  /** 移动/resize：卡片完整矩形不许压中立带（车道规则 server 端裁决） */
  async moveNode(id: number, patch: NodePatch): Promise<MoveNodeResult> {
    if (patch.x !== undefined || patch.w !== undefined) {
      const node = await this.canvas.byId(id);
      const server = node ? await this.server.byId(node.serverId) : undefined;
      if (node && server) {
        const local = server.builtin;
        const x = patch.x ?? node.x;
        const w = patch.w ?? node.w;
        if (violatesLane(local, x, w))
          return {
            ok: false,
            error: local
              ? "本机服务器不能压到中立带（远程区一侧）"
              : "远程服务器不能压到中立带（本机区一侧）",
          };
      }
    }
    await this.canvas.moveNode(id, patch);
    return { ok: true };
  }

  /** 删除分组：组内目标回落到服务器卡（deploy 上下文清 groupId） */
  async removeGroup(id: number): Promise<void> {
    await this.deploy.clearGroup(id);
    await this.canvas.removeGroup(id);
  }
}
