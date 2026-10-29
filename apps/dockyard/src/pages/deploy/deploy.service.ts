// DeployService：部署原子的公开 API + run 状态机（锁/SSE/日志/prune）。
// 部署内核已按六阶段流水线拆出：阶段契约与共享段在 pipeline.ts，四形态在 forms.ts
// （见 apps/docs/docs/部署抽象.md）。本类只做编排：建行 → resolveForm → executeForm → 收尾。
import { ServiceError } from "@elysiax/core";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { AppPaths } from "../../shared/paths";
import { decryptSecret, encryptSecret } from "../../shared/crypto";
import { CANVAS_CHANNEL, events, type CanvasEvent } from "./events";
import type { DeployArtifact, DeployTarget, Deployment, DepEdge, TargetService } from "./schema";
import type { Project, ProjectService } from "../projects/projects.socket";
import type { ResourceService, SharedEnv } from "../resources/resources.socket";
import type { ServerService } from "../servers/servers.socket";
import { parseOwnerRepo, type GithubService } from "../github/github.socket";
import type { CanvasService } from "../canvas/canvas.socket";
import { isLocalHost } from "../canvas/canvas.socket";
import type { DeployRepository } from "./deploy.repository";
import type { EdgeService } from "../edge/edge.socket";
import { envFilePaths, type DetectedService } from "./detect";
import {
  activateArtifact,
  createHarness,
  executeForm,
  type DeployForm,
  type Harness,
  type Log,
  type SetStatus,
  type SetStage,
} from "./pipeline";
import { dbContainerForm, dbLogicalForm, githubAppForm, localAppForm } from "./forms";
import {
  containerNameOf,
  dbCompose,
  generatePassword,
  instanceUrl,
  LOGICAL_DB_SUPPORT,
  logicalDbUrl,
  suggestedEnvKey,
  type DbType,
} from "../resources/resources.socket";

/** 每个 target 保留的部署历史条数（超出由 pruneRuns 清理，chunks 级联删除） */
const RUNS_KEEP = 20;

/** 可引用的数据库连接（app 依赖选择器的一行） */
export interface DbRef {
  id: number;
  nodeId: number;
  name: string;
  dbType: DbType;
  logical: boolean;
  url: string;
  displayUrl: string; // 脱敏预览（密码段 •••），选择器里展示用
  envKey: string; // 建议注入的变量名（DATABASE_URL / REDIS_URL）
}

export class DeployService {
  /** 防同 target 重入 */
  private running = new Map<number, Promise<void>>();
  /** 六阶段执行能力集（远端助手 + 能力探测缓存），构造时装配一次 */
  private readonly harness: Harness;

  constructor(
    private readonly repo: DeployRepository,
    private readonly serverService: ServerService,
    private readonly github: GithubService,
    private readonly canvas: CanvasService,
    private readonly paths: AppPaths,
    private readonly edge: EdgeService,
    private readonly project: ProjectService,
    private readonly resourceService: ResourceService,
  ) {
    this.harness = createHarness({ repo, serverService, github, canvas, paths, edge, project });
  }

  /** 项目导入来源：github = 远端拉代码+服务器构建；local = 本地构建+镜像推送。
   *  旧数据 sourceType 为 null，按 localPath/repoUrl 推断。
   *  世界地图：归属在 target.projectId 上；未关联时按 repoUrl 反查项目兜底。 */
  private async sourceOf(target: DeployTarget): Promise<{ type: "local" | "github"; project?: Project }> {
    const project = target.projectId
      ? await this.project.byId(target.projectId)
      : (await this.project.list()).find((p) => p.repoUrl && p.repoUrl === target.repoUrl);
    const type: "local" | "github" =
      project?.sourceType ?? (project?.localPath && !target.repoUrl ? "local" : "github");
    return { type, project };
  }

  /** 形态分派（坐标解析）：kind/来源 → 六阶段前半段的组合实现 */
  private async resolveForm(target: DeployTarget): Promise<DeployForm> {
    if (target.kind === "db") return target.instanceOf ? dbLogicalForm : dbContainerForm;
    const { type, project } = await this.sourceOf(target);
    if (type === "local") {
      if (!project?.localPath) throw new ServiceError("本地导入的项目缺少 localPath");
      return localAppForm(project);
    }
    return githubAppForm;
  }

  targetsOfNode(nodeId: number) {
    return this.repo.targetsOfNode(nodeId);
  }

  targetById(id: number) {
    return this.repo.targetById(id);
  }

  latestDeployment(targetId: number) {
    return this.repo.latestDeployment(targetId);
  }

  /** SSE 首帧快照：每个 target 最近一次 run 的 status/stage。
   *  没有它，页面刷新后已部署的卡会一直显示「未部署」直到下一次状态事件。 */
  async statusSnapshot(): Promise<CanvasEvent[]> {
    const out: CanvasEvent[] = [];
    for (const node of await this.canvas.nodesAll()) {
      for (const t of await this.repo.targetsOfNode(node.id)) {
        const dep = await this.repo.latestDeployment(t.id);
        if (dep) out.push({ type: "status", targetId: t.id, status: dep.status, stage: dep.stage ?? undefined });
      }
    }
    return out;
  }

  /** 整段日志（分块拼接；兼容存量 logText 行） */
  logTextOf(runId: number) {
    return this.repo.logTextOf(runId);
  }

  /** 同卡片同类型名称唯一（db 层还有唯一索引兜底，这里给用户友好报错） */
  private async assertNameFree(nodeId: number, kind: "app" | "db", name: string) {
    const dup = (await this.repo.targetsOfNode(nodeId)).find(
      (t) => t.kind === kind && t.name === name,
    );
    if (dup) throw new ServiceError(`该服务器上已存在同名${kind === "db" ? "数据库" : "应用"}「${name}」`);
  }

  async createAppTarget(input: {
    nodeId: number; name: string; repoUrl?: string; branch: string;
    composePath: string; serviceName?: string; remoteDir: string;
    envText?: string; // 识别结果合并出的 .env（enc1: 加密落库）
    overrideCompose?: string | null; // 资源限制 override（compose -f 叠加）
    dependsOn?: number[]; // 依赖的 db target id（画布连线 + 连接串引用血缘）
    domains?: { hostname: string; serviceName?: string; targetPort: number }[];
    services?: DetectedService[]; // compose 服务清单（画布小卡片；剥离秘密值后明文落库）
    upServices?: string[]; // 实际 up 的服务子集（共享资源复用过滤中间件；undefined = 全量）
    projectId?: number; // 项目归属（缺省按 repoUrl 反查项目；都没有 → null 未关联）
  }) {
    if (input.repoUrl?.trim()) parseOwnerRepo(input.repoUrl); // 提前校验（本地导入可无仓库）
    await this.assertNameFree(input.nodeId, "app", input.name);
    const { envText, overrideCompose, domains, dependsOn, services, upServices, projectId, ...base } = input;
    // 世界地图：项目归属落在 target 上——显式传入优先，否则按仓库地址反查
    const project = projectId
      ? await this.project.byId(projectId)
      : (await this.project.list()).find((p) => p.repoUrl && p.repoUrl === input.repoUrl?.trim());
    const target = await this.repo.createTarget({
      kind: "app",
      ...base,
      projectId: project?.id ?? null,
      ...(dependsOn?.length ? { dependsOn } : {}),
      ...(upServices?.length ? { upServices } : {}),
      // 只存 name/port：env 是秘密（envJson/overrideCompose 加密通道），cpu/mem 已在 override
      ...(services ? { servicesJson: { services: services.map((s) => ({ name: s.name, port: s.port })) } } : {}),
    });
    // 逻辑库容器名定死（对账用）；app 的容器名由用户 compose 决定，config 时读
    if (envText?.trim() || overrideCompose)
      await this.repo.updateTarget(target.id, {
        ...(envText?.trim() ? { envJson: encryptSecret(envText) } : {}),
        // override 含服务级 environment（秘密值），enc1: 加密落库
        ...(overrideCompose ? { overrideCompose: encryptSecret(overrideCompose) } : {}),
      });
    // 域名归 edge 上下文（含抢占检查）；建行后再绑，失败则整单撤掉
    try {
      for (const d of domains ?? [])
        await this.edge.addDomain(target.id, d);
    } catch (e) {
      await this.repo.removeTarget(target.id);
      throw e;
    }
    return (await this.repo.targetById(target.id))!;
  }

  /**
   * app 的 compose 服务清单（画布小卡片 + 容器标签对账）：
   * 优先读 servicesJson 列；为 null（存量 target）则从本地仓库缓存跑 compose config 惰性补全并写回。
   * 一切失败都静默降级为空——画布轮询路径不能因为补全挂掉。
   */
  async servicesOfTarget(target: DeployTarget): Promise<{ project: string | null; services: TargetService[] }> {
    if (target.kind !== "app") return { project: null, services: [] };
    const fallbackProject = `dockyard-${target.id}`; // 与 activate 的 cfg.name ?? dockyard-<id> 同源
    if (target.servicesJson)
      return { project: target.servicesJson.project ?? fallbackProject, services: target.servicesJson.services };
    try {
      // 本地导入直接读项目目录；GitHub 导入读本地克隆缓存（远端构建后缓存可能不存在 → 静默降级）
      const { type, project } = await this.sourceOf(target);
      const repoDir =
        type === "local" && project?.localPath
          ? join(project.localPath, project.rootDir ?? "")
          : join(this.paths.reposDir, `target-${target.id}`);
      if (!existsSync(repoDir)) return { project: null, services: [] };
      const composePath = target.composePath ?? "docker-compose.yml";
      // env_file 多为 gitignore 的本地秘密（仓库缓存里没有）→ 写占位，否则 compose config 直接报错（同部署路径做法）
      const composeText = await Bun.file(join(repoDir, composePath)).text();
      for (const p of envFilePaths(composeText)) {
        // 相对 compose 文件所在目录解析；${VAR:-default} 取默认值（与 compose 行为一致）
        const resolved = p.replace(/\$\{[^}:]+:-([^}]*)\}/g, "$1");
        const abs = join(repoDir, dirname(composePath), resolved);
        if (!existsSync(abs)) {
          await mkdir(dirname(abs), { recursive: true });
          await Bun.write(abs, "# dockyard 占位：真实环境变量在 docker-compose.dockyard.yml 的 environment 里\n");
        }
      }
      const proc = Bun.spawn(
        ["docker", "compose", "-f", composePath, "config", "--format", "json"],
        { cwd: repoDir, stdout: "pipe", stderr: "ignore" },
      );
      const cfg = JSON.parse(await new Response(proc.stdout).text()) as {
        name?: string;
        services?: Record<string, { image?: string; ports?: { published?: string | number }[] }>;
      };
      if ((await proc.exited) !== 0) return { project: null, services: [] };
      const services = Object.entries(cfg.services ?? {}).map(([name, def]): TargetService => {
        const published = def.ports?.[0]?.published;
        const port = published === undefined ? undefined : Number(published);
        return { name, image: def.image, port: Number.isFinite(port) ? port : undefined };
      });
      const doc = { ...(cfg.name ? { project: cfg.name } : {}), services };
      await this.repo.updateTarget(target.id, { servicesJson: doc }).catch(() => {});
      return { project: cfg.name ?? fallbackProject, services };
    } catch {
      return { project: null, services: [] };
    }
  }

  /** 域名变更后的 edge 全量对账（增删域名、手动「重新同步」按钮共用） */
  async syncEdge(targetId: number, log: Log = async () => {}) {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new ServiceError("部署目标不存在");
    await this.edge.syncServer(await this.harness.nodeServerId(target), log);
  }

  // ── 依赖与连接串引用 ──

  /** 项目空间内可引用的数据库连接（app 向导/变量抽屉的选择器数据）。
   *  世界地图：节点不再携带项目——取卡上已有 target 的项目归属；全新服务器卡无归属时返回空 */
  async dbRefsOfNode(nodeId: number): Promise<DbRef[]> {
    const projectId = (await this.repo.targetsOfNode(nodeId)).find((t) => t.projectId)?.projectId;
    if (!projectId) return [];
    const dbs = await this.repo.dbTargetsOfProject(projectId);
    const refs: DbRef[] = [];
    for (const db of dbs) {
      if (!db.dbType || !db.envJson) continue;
      let url: string | null = null;
      try {
        const parsed = JSON.parse(decryptSecret(db.envJson)) as Record<string, unknown>;
        if (db.instanceOf) {
          url = typeof parsed.url === "string" ? parsed.url : null; // 逻辑库：凭据创建时生成
        } else {
          const server = await this.serverService.byId(await this.harness.nodeServerId(db));
          url = instanceUrl(db.dbType as DbType, server?.host ?? "", String(parsed.env ?? ""));
        }
      } catch { /* 跳过坏记录 */ }
      if (!url) continue;
      refs.push({
        id: db.id, nodeId: db.nodeId, name: db.name,
        dbType: db.dbType as DbType, logical: Boolean(db.instanceOf),
        url,
        displayUrl: url.replace(/(\/\/[^:/@]+:)[^@]+(@)/, "$1•••$2"),
        envKey: suggestedEnvKey(db.dbType as DbType),
      });
    }
    return refs;
  }

  /** 目标所在服务器的共享变量（Env Tab 下拉引用；url 已解密，仅本机控制面） */
  async sharedEnvOfTarget(targetId: number): Promise<SharedEnv[]> {
    const target = await this.repo.targetById(targetId);
    if (!target) return [];
    return this.resourceService.sharedEnvOf(await this.harness.nodeServerId(target));
  }

  /** Source Tab：更新来源配置（仓库/分支/compose 路径/远端目录） */
  async updateSource(
    targetId: number,
    patch: { repoUrl?: string; branch?: string; composePath?: string; remoteDir?: string },
  ) {
    const target = await this.repo.targetById(targetId);
    if (!target || target.kind !== "app") throw new ServiceError("部署目标不存在");
    if (patch.repoUrl?.trim()) parseOwnerRepo(patch.repoUrl);
    await this.repo.updateTarget(targetId, {
      ...(patch.repoUrl !== undefined ? { repoUrl: patch.repoUrl.trim() || null } : {}),
      ...(patch.branch?.trim() ? { branch: patch.branch.trim() } : {}),
      ...(patch.composePath?.trim() ? { composePath: patch.composePath.trim() } : {}),
      ...(patch.remoteDir?.trim() ? { remoteDir: patch.remoteDir.trim() } : {}),
    });
  }

  /** app 的 .env 明文（变量抽屉回显；enc1: 解密，仅本机控制面） */
  envTextOf(target: DeployTarget): string {
    if (!target.envJson) return "";
    try {
      return decryptSecret(target.envJson);
    } catch {
      return "";
    }
  }

  /** 逻辑库连接串（画布复制按钮；本地控制面，落库已 enc1: 加密）。非逻辑库 → undefined */
  logicalUrlOf(target: DeployTarget): string | undefined {
    if (target.kind !== "db" || !target.instanceOf || !target.envJson) return undefined;
    try {
      return (JSON.parse(decryptSecret(target.envJson)) as { url?: string }).url;
    } catch {
      return undefined;
    }
  }

  /** 变量抽屉保存：.env（enc1: 加密）+ 依赖血缘（画布连线） */
  async updateAppEnv(targetId: number, envText: string, dependsOn: number[]) {
    const target = await this.repo.targetById(targetId);
    if (!target || target.kind !== "app") throw new ServiceError("部署目标不存在");
    await this.repo.updateTarget(targetId, {
      envJson: envText.trim() ? encryptSecret(envText) : null,
      dependsOn: dependsOn.length ? dependsOn : null,
    });
  }

  /** 画布拖线建/删依赖：整组覆盖服务级边；dependsOn 是派生血缘（变量抽屉选择器用），双写保持一致 */
  async setDependsOn(targetId: number, edges: DepEdge[]) {
    const target = await this.repo.targetById(targetId);
    if (!target || target.kind !== "app") throw new ServiceError("部署目标不存在");
    const dependsOn = [...new Set(edges.map((e) => e.db))];
    await this.repo.updateTarget(targetId, {
      depEdges: edges.length ? edges : null,
      dependsOn: dependsOn.length ? dependsOn : null,
    });
  }

  /** app 的服务级依赖边（depEdges 为空的存量数据从 dependsOn 惰性派生，service=null 表示整体依赖） */
  edgesOfTarget(target: DeployTarget): DepEdge[] {
    if (target.depEdges) return target.depEdges;
    return (target.dependsOn ?? []).map((db) => ({ service: null, db }));
  }

  /** 画布布局持久化：app/db 卡位置 + 服务卡位置（serviceLayout 全量覆盖，岛端合并后传） */
  async setLayout(targetId: number, patch: { x?: number; y?: number; w?: number; h?: number; groupId?: number | null; serviceLayout?: Record<string, { x: number; y: number }> }) {
    await this.repo.updateTarget(targetId, patch);
  }

  /** 删除分组：组内目标回落到服务器卡 */
  async clearGroup(groupId: number) {
    await this.repo.clearGroup(groupId);
  }

  // ── 部署历史（服务抽屉 Deployments Tab）──

  deploymentsOfTarget(targetId: number) {
    return this.repo.deploymentsOfTarget(targetId);
  }

  deploymentById(id: number) {
    return this.repo.deploymentById(id);
  }

  /** override compose 整列覆盖（runtime 原子的资源限制/服务变量保存用；enc1: 加密在调用方） */
  async updateOverrideCompose(targetId: number, overrideCompose: string | null) {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new ServiceError("部署目标不存在");
    await this.repo.updateTarget(targetId, { overrideCompose });
  }

  /** 部署策略三态：manual 不轮询 / notify 只亮徽章 / auto 检出更新即部署（轮询器读此列） */
  async setDeployPolicy(targetId: number, deployPolicy: DeployTarget["deployPolicy"]) {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new ServiceError("部署目标不存在");
    await this.repo.updateTarget(targetId, { deployPolicy });
  }

  /** 该节点上可托管逻辑库的实例（kind=db、同类型、非逻辑库） */
  async instancesOfNode(nodeId: number, dbType: DbType): Promise<DeployTarget[]> {
    return (await this.repo.targetsOfNode(nodeId)).filter(
      (t) => t.kind === "db" && !t.instanceOf && t.dbType === dbType,
    );
  }

  /** 数据库目标（实例）：模板 compose + 凭据在创建时生成一次，enc1: 加密存 envJson。
   *  容器名/所有权标签依赖 target id，先建行再回填。 */
  async createDbTarget(input: { nodeId: number; name: string; dbType: DbType; remoteDir: string; projectId?: number }) {
    await this.assertNameFree(input.nodeId, "db", input.name);
    if (!input.remoteDir.trim()) throw new ServiceError("新建实例需要填写远端目录");
    const target = await this.repo.createTarget({ kind: "db", ...input });
    const rendered = dbCompose(input.dbType, input.name, {
      targetId: target.id,
      // compose 项目名：有归属按项目，未关联兜底 target id（保持全局唯一）
      project: `project-${input.projectId ?? target.id}`,
    });
    const containerName = containerNameOf(target.id, input.name);
    await this.repo.updateTarget(target.id, {
      envJson: encryptSecret(JSON.stringify(rendered)),
      containerName,
    });
    return (await this.repo.targetById(target.id))!;
  }

  /** 逻辑库目标：不起容器，凭据创建时生成，部署 = 在宿主实例里 CREATE DATABASE */
  async createLogicalDbTarget(input: { nodeId: number; name: string; instanceId: number }) {
    const instance = await this.repo.targetById(input.instanceId);
    if (!instance || instance.kind !== "db" || instance.instanceOf)
      throw new ServiceError("宿主实例不存在");
    if (!LOGICAL_DB_SUPPORT[instance.dbType as DbType])
      throw new ServiceError(`${instance.dbType} 不支持逻辑库`);
    await this.assertNameFree(input.nodeId, "db", input.name);
    const serverId = await this.harness.nodeServerId(instance);
    const server = await this.serverService.byId(serverId);
    const password = generatePassword();
    const url = logicalDbUrl(instance.dbType as DbType, server!.host, input.name, password);
    return this.repo.createTarget({
      kind: "db",
      nodeId: input.nodeId,
      name: input.name,
      dbType: instance.dbType,
      instanceOf: instance.id,
      projectId: instance.projectId, // 逻辑库跟随宿主实例的项目归属
      envJson: encryptSecret(JSON.stringify({ url, password })),
    });
  }

  /** 删除：实例旗下有逻辑库时阻止；逻辑库只删记录（不 DROP DATABASE） */
  async removeTarget(id: number) {
    const target = await this.repo.targetById(id);
    if (!target) return;
    if (target.kind === "db" && !target.instanceOf) {
      const children = await this.repo.childrenOf(id);
      if (children.length > 0)
        throw new ServiceError(
          `实例下还有逻辑库：${children.map((c) => c.name).join("、")}，请先删除它们`,
        );
    }
    return this.repo.removeTarget(id);
  }

  isRunning(targetId: number) {
    return this.running.has(targetId);
  }

  /** 触发部署（幂等防重入；调用方通常不 await）。trigger 标记来源（ui/auto），进 run 血缘 */
  deploy(targetId: number, opts?: { trigger?: Deployment["trigger"] }): Promise<void> {
    const hit = this.running.get(targetId);
    if (hit) return hit;
    const task = this.pipeline(targetId, opts?.trigger ?? "ui")
      .catch(() => { })
      .finally(() => this.running.delete(targetId));
    this.running.set(targetId, task);
    return task;
  }

  private async pipeline(targetId: number, trigger: Deployment["trigger"]) {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new ServiceError(`部署目标不存在: ${targetId}`);
    // 画布 SSE 全局频道：状态迁移实时推给订阅画布的浏览器（structure 不变，不走 refresh）
    const ch = CANVAS_CHANNEL;
    const dep = await this.repo.createDeployment(targetId, { trigger });
    const log = this.makeLog(dep.id, targetId);
    const { setStatus, setStage } = this.makeRunControls(dep, targetId, ch);

    events.publish(ch, { type: "running", targetId, running: true });
    events.publish(ch, { type: "status", targetId, status: "queued" });
    try {
      const form = await this.resolveForm(target);
      await executeForm(this.harness, { target, run: dep, log, setStatus, setStage }, form);
      await setStatus("success", { finishedAt: new Date() });
      await log("✅ 部署完成");
      await this.repo.pruneRuns(targetId, RUNS_KEEP);
    } catch (error) {
      await log(`❌ ${(error as Error).message}`);
      await setStatus("failed", { finishedAt: new Date() });
    } finally {
      await log.flush(); // 终态前推空缓冲，抽屉侧才能即时收尾
      events.publish(ch, { type: "running", targetId, running: false });
    }
  }

  /**
   * setStatus/setStage 对：写库 + SSE。status 是粗状态机（六值 CHECK 约束），
   * stage 是细步骤进度（best-effort）；stage 并入 status 事件推送，前端缺省保留合并。
   */
  private makeRunControls(dep: Deployment, targetId: number, ch: string) {
    let current: Deployment["status"] = dep.status;
    const setStatus: SetStatus = async (status, patch = {}) => {
      current = status;
      await this.repo.updateDeployment(dep.id, { status, ...patch });
      events.publish(ch, { type: "status", targetId, status });
    };
    const setStage: SetStage = async (stage) => {
      await this.repo.updateDeployment(dep.id, { stage });
      events.publish(ch, { type: "status", targetId, status: current, stage });
    };
    return { setStatus, setStage };
  }

  /**
   * 部署日志 writer：chunk 落库 + SSE 增量推送。
   * 落库逐行（appendLogChunk 单行 insert 足够快）；SSE 必须合并——
   * execLongRemote 一个 256KB 轮询窗口可能含上千行，逐行 publish 会打爆频道。
   * 窗口规则：满 50 行立即 flush，否则 100ms 后 flush；终态由 pipeline 强制 flush。
   */
  private makeLog(runId: number, targetId: number): Log & { flush(): Promise<void> } {
    let buf: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!buf.length) return;
      const lines = buf;
      buf = [];
      events.publish(CANVAS_CHANNEL, { type: "log", targetId, runId, lines });
    };
    const log: Log = async (line) => {
      if (!line.trim()) return;
      await this.repo.appendLogChunk(runId, line);
      buf.push(line);
      if (buf.length >= 50) await flush();
      else timer ??= setTimeout(() => void flush(), 100);
    };
    return Object.assign(log, { flush });
  }

  /** run → 产物：优先走 artifactId（0017 之后）；存量行防御性合成（迁移已回填，双保险） */
  private async artifactOfRun(src: Deployment): Promise<DeployArtifact | undefined> {
    if (src.artifactId) return this.repo.artifactById(src.artifactId);
    if (src.snapshotJson)
      return {
        id: 0,
        targetId: src.targetId,
        runId: src.id,
        kind: "compose",
        project: src.project,
        imageTags: src.imageSnapshot,
        snapshotJson: src.snapshotJson,
        sha: src.commitSha,
        createdAt: src.startedAt,
      };
    return undefined;
  }

  /**
   * 回滚到某次成功部署：校验放 await 段（产物缺失/记录错位直接抛回 actions），
   * 之后才进 running Map（与 deploy 同锁，部署/回滚互斥）。
   */
  async rollback(targetId: number, runId: number): Promise<void> {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new ServiceError(`部署目标不存在: ${targetId}`);
    const src = await this.repo.deploymentById(runId);
    if (!src || src.targetId !== targetId) throw new ServiceError(`部署记录不存在: ${runId}`);
    const artifact = await this.artifactOfRun(src);
    if (src.status !== "success" || !artifact)
      throw new ServiceError("该记录缺少快照，无法回滚（仅本轮之后的部署会产生快照）");

    const hit = this.running.get(targetId);
    if (hit) return;
    const task = this.rollbackPipeline(target, src, artifact)
      .catch(() => { })
      .finally(() => this.running.delete(targetId));
    this.running.set(targetId, task);
    // 不返回 task：调用方 await 到的是「校验通过、已开播」，不是整个回滚过程
  }

  private async rollbackPipeline(target: DeployTarget, src: Deployment, artifact: DeployArtifact) {
    const targetId = target.id;
    const ch = CANVAS_CHANNEL;
    // 回滚 = 激活旧产物：新 run 引用同一 artifact（产物与 run 解耦，同一产物可多次激活）
    const dep = await this.repo.createDeployment(targetId, {
      trigger: "rollback",
      rollbackOf: src.id,
      ...(artifact.id ? { artifactId: artifact.id } : {}),
    });
    const log = this.makeLog(dep.id, targetId);
    const { setStatus, setStage } = this.makeRunControls(dep, targetId, ch);

    events.publish(ch, { type: "running", targetId, running: true });
    events.publish(ch, { type: "status", targetId, status: "queued" });
    try {
      await setStatus("deploying", { commitSha: src.commitSha });
      await activateArtifact(this.harness, { target, run: dep, log, setStatus, setStage }, artifact);
      await setStatus("success", { finishedAt: new Date() });
      await log("✅ 回滚完成");
      // 回滚是「留旧版」的明确意图：auto 策略不降级的话，下一轮轮询会立刻把坏 sha 自动部回去
      if (target.deployPolicy === "auto") {
        await this.repo.updateTarget(targetId, { deployPolicy: "notify" });
        await log("⚠️ 部署策略已从「自动部署」降级为「仅提醒」——确认修复后可在抽屉里改回");
      }
      await this.repo.pruneRuns(targetId, RUNS_KEEP);
    } catch (error) {
      await log(`❌ ${(error as Error).message}`);
      await setStatus("failed", { finishedAt: new Date() });
    } finally {
      await log.flush();
      events.publish(ch, { type: "running", targetId, running: false });
    }
  }

  /**
   * 「传输产物」独立动作：本地构建 + 推到远端，不起容器 = localApp 形态的 provision 段。
   * 用途 = 跨区移动前的显式通道（artifactShipped 置位）。建 run 行复用日志面板看进度。
   */
  async shipArtifact(targetId: number): Promise<void> {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new ServiceError(`部署目标不存在: ${targetId}`);
    if (target.kind !== "app") throw new ServiceError("只有应用需要传输产物");
    const { type, project } = await this.sourceOf(target);
    if (type !== "local" || !project?.localPath)
      throw new ServiceError("只有本地导入的应用有「传输产物」——GitHub 导入在远端直接构建");
    if (this.running.has(targetId)) return;

    const form = localAppForm(project);
    const task = (async () => {
      const ch = CANVAS_CHANNEL;
      // trigger=ship：仅传输不起容器，与真部署在历史里可辨（体检病-4：success 语义不混杂）
      const dep = await this.repo.createDeployment(targetId, { trigger: "ship" });
      const log = this.makeLog(dep.id, targetId);
      const { setStatus, setStage } = this.makeRunControls(dep, targetId, ch);
      events.publish(ch, { type: "running", targetId, running: true });
      events.publish(ch, { type: "status", targetId, status: "queued" });
      try {
        await form.provision!({ target, run: dep, log, setStatus, setStage }, this.harness);
        await setStatus("success", { finishedAt: new Date() });
        await log("✅ 产物已传输（容器未启动；可将卡移入远程区后部署）");
      } catch (error) {
        await log(`❌ ${(error as Error).message}`);
        await setStatus("failed", { finishedAt: new Date() });
      } finally {
        await log.flush();
        events.publish(ch, { type: "running", targetId, running: false });
      }
    })()
      .catch(() => { })
      .finally(() => this.running.delete(targetId));
    this.running.set(targetId, task);
  }

  /**
   * 卡迁移到另一台服务器（拖拽落位调这里）。
   * 区域硬隔离：local↔remote 跨界，app 必须 artifactShipped（产物已到云端），db 直接拒绝（数据不随卡走）。
   * 迁移后：groupId 清零（分组不跨服务器）；域名跟随 target → 新旧两台 edge 都对账；旧容器不自动清理（安全纪律）。
   */
  async moveTargetToNode(targetId: number, nodeId: number): Promise<void> {
    const target = await this.repo.targetById(targetId);
    if (!target) throw new ServiceError(`部署目标不存在: ${targetId}`);
    if (target.nodeId === nodeId) return; // 原地落位，无操作
    const node = await this.canvas.byId(nodeId);
    if (!node) throw new ServiceError("目标画布节点不存在");
    const oldNode = await this.canvas.byId(target.nodeId);
    if (!oldNode) throw new ServiceError("画布节点已删除");
    await this.assertNameFree(nodeId, target.kind, target.name);

    const [oldServer, newServer] = await Promise.all([
      this.serverService.byId(oldNode.serverId),
      this.serverService.byId(node.serverId),
    ]);
    const crossing = isLocalHost(oldServer?.host ?? "") !== isLocalHost(newServer?.host ?? "");
    if (target.kind !== "app") {
      if (crossing)
        throw new ServiceError("数据库不能跨区移动——数据不随卡走，请在目标服务器新建实例");
    } else {
      // 产物门票按「落点服务器」核验（不是布尔）：本地构建的镜像只 load 在当次目标上——
      // 换任何服务器（含 remote→remote 平移）都必须先重传到目标服务器，否则 up 会 pull 不存在的镜像名
      const { type } = await this.sourceOf(target);
      const shippedHere = target.artifactServerId != null && target.artifactServerId === node.serverId;
      const needTicket = type === "local" ? target.nodeId !== nodeId : crossing;
      if (needTicket && !shippedHere)
        throw new ServiceError("构建产物尚未传输到目标服务器——先在服务抽屉执行「传输产物」");
    }

    await this.repo.updateTarget(targetId, { nodeId, groupId: null, x: null, y: null });
    const domains = await this.edge.domainsOfTarget(targetId);
    if (domains.length) {
      const noop: Log = async () => {};
      // 旧服务器撤路由、新服务器建路由，两边都对账
      if (oldServer) await this.edge.syncServer(oldServer.id, noop);
      if (newServer) await this.edge.syncServer(newServer.id, noop);
    }
  }
}
