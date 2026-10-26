import { eq } from "drizzle-orm";
import type { Db } from "../../shared/db";
import { canvasNodes } from "../canvas/canvas.socket";
import type { ServerService } from "../servers/servers.socket";
import { deployTargets, type TargetServicesDoc } from "./schema";
import { CANVAS_CHANNEL, events, type CanvasEvent } from "./events";

const INTERVAL_MS = 10_000;

type SvcState = "running" | "exited" | "unknown";

/**
 * 后台容器状态轮询：每台服务器一次 docker ls（SSH 中继），对账到 compose 服务级状态，
 * 与上轮快照 diff，只把变化推上事件总线（SSE 下游）。SSH 频率与前端用户数无关；
 * 画布 SSE 是全局频道（世界地图）——无任何订阅者时整轮跳过，不建连接。
 * DI 装配（deploy.di.ts provide），index.ts 从根容器取出后 start()。
 */
export class ContainerPoller {
  /** key = `${targetId}:${service}`；not-found 也记 unknown，容器消失时能推出变化 */
  private readonly snapshot = new Map<string, SvcState>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly serverService: ServerService,
    private readonly db: Db,
  ) {}

  /** SSE 端点订阅时的首帧：把已知的容器状态全量重发一遍（世界地图无项目过滤） */
  statesAll(): CanvasEvent[] {
    const out: CanvasEvent[] = [];
    for (const [key, state] of this.snapshot) {
      const sep = key.indexOf(":");
      out.push({ type: "state", targetId: Number(key.slice(0, sep)), service: key.slice(sep + 1), state });
    }
    return out;
  }

  start(intervalMs = INTERVAL_MS) {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    return this.timer;
  }

  private async tick() {
    const rows = await this.db
      .select({
        targetId: deployTargets.id,
        serverId: canvasNodes.serverId,
        servicesJson: deployTargets.servicesJson,
      })
      .from(deployTargets)
      .innerJoin(canvasNodes, eq(deployTargets.nodeId, canvasNodes.id))
      .where(eq(deployTargets.kind, "app"));

    const byServer = new Map<number, typeof rows>();
    for (const r of rows) {
      const arr = byServer.get(r.serverId) ?? [];
      arr.push(r);
      byServer.set(r.serverId, arr);
    }

    // target/服务被删 → 清掉快照里的孤儿 key（不推事件，前端结构 refresh 会带走卡片）；
    // 以 DB 行（而非本轮可达的服务器）为准，跳过/离线的服务器不会误清
    const known = new Set<string>();
    for (const r of rows)
      for (const s of r.servicesJson?.services ?? []) known.add(`${r.targetId}:${s.name}`);
    for (const key of this.snapshot.keys()) if (!known.has(key)) this.snapshot.delete(key);

    // 全局频道无观众 → 整轮不 SSH（仍保留上面的快照清理）
    if (!events.hasSubs(CANVAS_CHANNEL)) return;

    for (const [serverId, targets] of byServer) {
      const apps = targets.filter((t) => t.servicesJson?.services?.length);
      if (!apps.length) continue;
      let containers: { Labels?: Record<string, string>; State?: string }[];
      try {
        const docker = await this.serverService.docker(serverId);
        containers = await docker.listContainers({ all: true }) as typeof containers;
      } catch {
        continue; // 服务器离线/SSH 失败 → 保持上轮快照，不推
      }
      for (const t of apps) {
        const doc = t.servicesJson as TargetServicesDoc;
        const project = doc.project ?? `dockyard-${t.targetId}`; // 与 deploy.service servicesOfTarget 同源
        for (const s of doc.services) {
          const match = (c: { Labels?: Record<string, string> }) =>
            c.Labels?.["com.docker.compose.project"] === project &&
            c.Labels?.["com.docker.compose.service"] === s.name;
          const hit = containers.find((c) => match(c) && c.State === "running") ?? containers.find(match);
          const state: SvcState = hit ? (hit.State === "running" ? "running" : "exited") : "unknown";
          const key = `${t.targetId}:${s.name}`;
          if (this.snapshot.get(key) === state) continue;
          this.snapshot.set(key, state);
          events.publish(CANVAS_CHANNEL, { type: "state", targetId: t.targetId, service: s.name, state });
        }
      }
    }
  }
}
