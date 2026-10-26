import { ServiceError } from "@elysiax/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { decryptSecret, encryptSecret } from "../../../shared/crypto";
import { textToEnvMap } from "../../../shared/env-text";
import { containerNameOf } from "../../resources/resources.socket";
import type { CanvasService } from "../../canvas/canvas.socket";
import type { ServerService } from "../../servers/servers.socket";
// 父子之间也走插座：deploy 的服务经父原子插座引入
import type { DeployService, DeployTarget } from "../deploy.socket";

/**
 * 运行时操作（嵌套原子）：容器交互/指标/日志/资源限制/服务变量。
 * 数据仍在 deploy_targets（父原子的表），写操作经 DeployService 的领域方法，不直接碰 repository。
 */
export class RuntimeService {
  constructor(
    private readonly deploy: DeployService,
    private readonly canvas: CanvasService,
    private readonly server: ServerService,
  ) {}

  /** target → 它所在服务器的 dockerode 连接（SSH 中继） */
  private async dockerOfTarget(target: DeployTarget) {
    const node = await this.canvas.byId(target.nodeId);
    if (!node) throw new ServiceError("画布节点不存在");
    return this.server.docker(node.serverId);
  }

  /** 服务 → 容器：app 服务按 compose 标签对账；db 实例按 dockyard.target-id 标签（running 优先） */
  private async containerOfService(target: DeployTarget, svcName?: string) {
    const docker = await this.dockerOfTarget(target);
    const containers = await docker.listContainers({ all: true }) as unknown as {
      Id: string; Names?: string[]; Labels?: Record<string, string>; State?: string;
    }[];
    let hit;
    if (target.kind === "app" && svcName) {
      const { project } = await this.deploy.servicesOfTarget(target);
      const match = (c: { Labels?: Record<string, string> }) =>
        c.Labels?.["com.docker.compose.project"] === project &&
        c.Labels?.["com.docker.compose.service"] === svcName;
      hit = containers.find((c) => match(c) && c.State === "running") ?? containers.find(match);
    } else {
      const owned = (c: { Labels?: Record<string, string>; Names?: string[] }) =>
        c.Labels?.["dockyard.target-id"] === String(target.id) ||
        c.Names?.includes(`/${containerNameOf(target.id, target.name)}`);
      hit = containers.find((c) => owned(c) && c.State === "running") ?? containers.find(owned);
    }
    return hit ? docker.getContainer(hit.Id) : null;
  }

  private async targetOrThrow(targetId: number): Promise<DeployTarget> {
    const target = await this.deploy.targetById(targetId);
    if (!target) throw new ServiceError("部署目标不存在");
    return target;
  }

  /** Console Tab：容器交互式终端（docker exec TTY，调用方负责桥接 WS 与关闭流） */
  async openConsole(targetId: number, svcName?: string) {
    const target = await this.targetOrThrow(targetId);
    const remote = await this.dockerOfTarget(target);

    let containerName: string;
    if (target.kind === "db") {
      if (!target.containerName) throw new ServiceError("数据库目标缺少容器名");
      containerName = target.containerName;
    } else {
      const { project, services } = await this.deploy.servicesOfTarget(target);
      const svc = svcName || services[0]?.name;
      if (!svc) throw new ServiceError("没有可进入的服务（先部署，或指定服务名）");
      containerName = `${project ?? `dockyard-${target.id}`}-${svc}-1`;
    }
    const containers = await remote.listContainers();
    const hit = containers.find((c) => c.Names.includes(`/${containerName}`));
    if (!hit) throw new ServiceError(`容器 ${containerName} 未在运行`);
    const container = remote.getContainer(hit.Id);
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"],
      Tty: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Env: ["TERM=xterm-256color", "COLORTERM=truecolor"],
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
    return { exec, stream };
  }

  /** 重启单个服务容器（svcName 空 = db 实例整体） */
  async restartService(targetId: number, svcName?: string) {
    const target = await this.targetOrThrow(targetId);
    const container = await this.containerOfService(target, svcName);
    if (!container) throw new ServiceError("容器未运行（先部署）");
    await container.restart();
  }

  /** 一次性资源快照（docker stats stream:false；容器不在 → null） */
  async serviceStats(targetId: number, svcName?: string): Promise<{
    state: string; cpuPercent: number; memUsage: number; memLimit: number; netRx: number; netTx: number;
  } | null> {
    const target = await this.deploy.targetById(targetId);
    if (!target) return null;
    try {
      const container = await this.containerOfService(target, svcName);
      if (!container) return null;
      const info = await container.inspect();
      if (!info.State.Running) return { state: info.State.Status ?? "exited", cpuPercent: 0, memUsage: 0, memLimit: 0, netRx: 0, netTx: 0 };
      const s = await container.stats({ stream: false });
      const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage?.total_usage ?? 0);
      const sysDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats.system_cpu_usage ?? 0);
      const cores = s.cpu_stats.online_cpus ?? s.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
      const cpuPercent = sysDelta > 0 ? (cpuDelta / sysDelta) * cores * 100 : 0;
      let netRx = 0, netTx = 0;
      for (const n of Object.values(s.networks ?? {})) { netRx += n.rx_bytes; netTx += n.tx_bytes; }
      return {
        state: "running",
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        memUsage: s.memory_stats.usage ?? 0,
        memLimit: s.memory_stats.limit ?? 0,
        netRx, netTx,
      };
    } catch {
      return null; // 服务器离线/SSH 失败 → 前端显示"指标不可用"
    }
  }

  /** 容器实时日志（≠ 部署日志）：docker logs --tail 300，非 TTY 输出带 8 字节多路复用帧头需剥离 */
  async serviceLogs(targetId: number, svcName?: string): Promise<string> {
    const target = await this.deploy.targetById(targetId);
    if (!target) return "部署目标不存在";
    try {
      const container = await this.containerOfService(target, svcName);
      if (!container) return "容器未运行（先部署）";
      const buf = await container.logs({ stdout: true, stderr: true, tail: 300 });
      const out: Buffer[] = [];
      let off = 0;
      while (off + 8 <= buf.length) {
        const size = buf.readUInt32BE(off + 4);
        out.push(buf.subarray(off + 8, off + 8 + size));
        off += 8 + size;
      }
      return Buffer.concat(out).toString("utf8").trimEnd() || "（无日志输出）";
    } catch (e) {
      return `日志不可用：${(e as Error).message}`;
    }
  }

  /** 服务的资源限制（override compose 的 cpus/mem_limit；无 → {}） */
  async serviceResources(targetId: number, svcName: string): Promise<{ cpuCores?: number; memoryMb?: number }> {
    const target = await this.deploy.targetById(targetId);
    if (!target?.overrideCompose) return {};
    try {
      const doc = parseYaml(decryptSecret(target.overrideCompose)) as {
        services?: Record<string, { cpus?: number | string; mem_limit?: string }>;
      } | null;
      const svc = doc?.services?.[svcName];
      const cpu = svc?.cpus !== undefined ? Number(svc.cpus) : undefined;
      const mem = svc?.mem_limit ? Number.parseInt(svc.mem_limit, 10) : undefined;
      return {
        cpuCores: cpu !== undefined && Number.isFinite(cpu) ? cpu : undefined,
        memoryMb: mem !== undefined && Number.isFinite(mem) ? mem : undefined,
      };
    } catch {
      return {};
    }
  }

  /** override compose 的 merge 改写：只动指定服务的指定字段，其余原样保留（资源限制/服务变量共用） */
  private async mergeOverride(targetId: number, svcName: string, mutate: (svc: Record<string, unknown>) => void) {
    const target = await this.targetOrThrow(targetId);
    type Doc = { services?: Record<string, Record<string, unknown>> };
    let doc: Doc = { services: {} };
    if (target.overrideCompose) {
      try { doc = (parseYaml(decryptSecret(target.overrideCompose)) as Doc | null) ?? { services: {} }; } catch { /* 损坏则重建 */ }
    }
    doc.services ??= {};
    const svc = (doc.services[svcName] ??= {});
    mutate(svc);
    if (Object.keys(svc).length === 0) delete doc.services[svcName];
    const empty = Object.keys(doc.services).length === 0 && Object.keys(doc).length === 1;
    await this.deploy.updateOverrideCompose(targetId, empty ? null : encryptSecret(stringifyYaml(doc)));
  }

  /** 保存资源限制：只动 override compose 里该服务的 cpus/mem_limit */
  async setServiceResources(targetId: number, svcName: string, cpuCores?: number, memoryMb?: number) {
    await this.mergeOverride(targetId, svcName, (svc) => {
      if (cpuCores) svc.cpus = cpuCores; else delete svc.cpus;
      if (memoryMb) svc.mem_limit = `${memoryMb}m`; else delete svc.mem_limit;
    });
  }

  /** 服务的注入变量（override compose 的 environment，enc1: 加密列里） */
  async serviceEnvText(targetId: number, svcName: string): Promise<string> {
    const target = await this.deploy.targetById(targetId);
    if (!target?.overrideCompose) return "";
    try {
      const doc = parseYaml(decryptSecret(target.overrideCompose)) as {
        services?: Record<string, { environment?: Record<string, string> | string[] }>;
      } | null;
      const env = doc?.services?.[svcName]?.environment;
      if (!env) return "";
      // override compose 的 environment 是纯 string map（detectToOverrideCompose 落的就是这个格式）
      if (Array.isArray(env)) return env.join("\n");
      return Object.entries(env).map(([k, v]) => `${k}=${v.includes(" ") ? JSON.stringify(v) : v}`).join("\n");
    } catch {
      return "";
    }
  }

  /** 保存服务变量：只动 override compose 里该服务的 environment */
  async setServiceEnv(targetId: number, svcName: string, envText: string) {
    await this.mergeOverride(targetId, svcName, (svc) => {
      const env = Object.fromEntries(Object.entries(textToEnvMap(envText)).map(([k, v]) => [k, v.value]));
      if (Object.keys(env).length) svc.environment = env;
      else delete svc.environment;
    });
  }
}
