import { ServiceError } from "@elysiax/core";
import Docker from "dockerode";
import { userInfo } from "node:os";
import type { Server } from "./schema";
import { encryptSecret } from "../../shared/crypto";
import { isLocalHost } from "./host";
import { SshPool, UnknownHostKeyError } from "./ssh-pool";
import { DockerRelay } from "./docker-relay";
import { LocalTransport, remoteTransport, type ServerTransport } from "./transport";
import type { ServerRepository, NewServer } from "./servers.repository";

export type CheckResult =
  | { ok: true; dockerVersion: string; warning?: string }
  | { ok: false; reason: "docker-missing" | "ssh-failed" | "local-failed"; message: string }
  | { ok: false; reason: "need-trust"; fingerprint: string; algorithm: string };

/** 内置本机行的固定字段：地址/用户/端口由程序定死，UI 不可编辑 */
const LOCAL_HOST = "127.0.0.1";
const LOCAL_PORT = 22;

export class ServerService {
  /** 本机传输无连接状态：单例即可 */
  private readonly localTransport = new LocalTransport();
  /** 本机 dockerode 走本地 socket，一次构建复用 */
  private localDocker?: Docker;

  constructor(
    private readonly repo: ServerRepository,
    private readonly sshPool: SshPool,
    private readonly relay: DockerRelay,
  ) {}

  list() {
    return this.repo.list();
  }

  byId(id: number) {
    return this.repo.byId(id);
  }

  /**
   * 启动即认领本机（程序管理，不是用户添加的资源）：
   * - 已有内置行：字段归一到固定值（程序说了算）；
   * - 存量回环行（老版本用户添加的 127.0.0.1:2222 之类）：原地升级为内置行，
   *   保留 id → 画布卡/部署目标的外键不断；
   * - 都没有：新建一行。
   */
  async ensureLocal(): Promise<Server> {
    const fixed = {
      name: "本机",
      host: LOCAL_HOST,
      port: LOCAL_PORT,
      user: userInfo().username,
      authType: "agent" as const,
      builtin: true,
    };
    const all = await this.repo.list();
    const own = all.find((s) => s.builtin) ?? all.find((s) => isLocalHost(s.host));
    if (!own) return this.repo.create(fixed);
    await this.repo.update(own.id, fixed);
    return (await this.repo.byId(own.id))!;
  }

  create(input: NewServer) {
    // 本机是内置资源：回环地址不允许走「添加服务器」
    if (isLocalHost(input.host)) {
      throw new ServiceError("本机由程序自动认领，不能手动添加；请填写远程服务器地址");
    }
    return this.repo.create({
      ...input,
      password: input.password ? encryptSecret(input.password) : undefined,
    });
  }

  async remove(id: number) {
    const server = await this.mustGet(id);
    if (server.builtin) throw new ServiceError("本机是内置服务器，不能删除");
    await this.sshPool.drop(id);
    this.relay.drop(id);
    return this.repo.remove(id);
  }

  /** 连接 + docker 检测；未知主机密钥时返回 need-trust 走 TOFU 确认（本机无此流程） */
  async check(id: number): Promise<CheckResult> {
    const server = await this.mustGet(id);
    try {
      const client = await this.transport(server.id);
      const { stdout, code } = await client.exec(
        "docker version --format '{{.Server.Version}}'",
      );
      if (code !== 0) {
        await this.repo.update(id, { dockerStatus: "missing", lastCheckedAt: new Date() });
        return { ok: false, reason: "docker-missing", message: "远端未安装 docker" };
      }
      const version = stdout.trim();
      // 机器指纹：/etc/machine-id + docker Server ID，防同机重复添加 / IP 漂移误部署
      const [machineId, dockerId] = await Promise.all([
        client.exec("cat /etc/machine-id 2>/dev/null").then((r) => r.stdout.trim() || null),
        client.exec("docker info --format '{{.ID}}' 2>/dev/null").then((r) => r.stdout.trim() || null),
      ]);
      let warning: string | undefined;
      if (server.machineId && machineId && server.machineId !== machineId) {
        warning = `机器指纹变更（原 ${server.machineId.slice(0, 8)}… → 现 ${machineId.slice(0, 8)}…），请确认没连错机器`;
      } else if (machineId) {
        const dup = (await this.repo.list()).find(
          (s) => s.id !== id && s.machineId === machineId,
        );
        if (dup) warning = `与「${dup.name}」是同一台物理机（machine-id 相同），注意别部署串了`;
      }
      await this.repo.update(id, {
        dockerStatus: "ok",
        dockerVersion: version,
        machineId: machineId ?? server.machineId,
        dockerId: dockerId ?? server.dockerId,
        lastCheckedAt: new Date(),
      });
      return { ok: true, dockerVersion: version, warning };
    } catch (error) {
      if (error instanceof UnknownHostKeyError) {
        return { ok: false, reason: "need-trust", fingerprint: error.fingerprint, algorithm: error.algorithm };
      }
      return {
        ok: false,
        reason: server.builtin ? "local-failed" : "ssh-failed",
        message: (error as Error).message,
      };
    }
  }

  /** TOFU：确认指纹后落库并立即重新检测 */
  async trust(id: number, fingerprint: string): Promise<CheckResult> {
    await this.repo.update(id, { hostKeyFingerprint: fingerprint });
    await this.sshPool.drop(id);
    return this.check(id);
  }

  /** 安装 docker（get.docker.com 官方脚本），返回完整输出 */
  async installDocker(id: number): Promise<{ code: number; output: string }> {
    const server = await this.mustGet(id);
    const client = await this.transport(server.id);
    const { stdout, stderr, code } = await client.exec(
      "curl -fsSL https://get.docker.com | sh",
    );
    if (code === 0) await this.check(id);
    return { code: code ?? -1, output: `${stdout}\n${stderr}`.trim() };
  }

  /** 远端 dockerode（经 SSH 中继 socket）；本机直连本地 docker.sock */
  async docker(id: number): Promise<Docker> {
    const server = await this.mustGet(id);
    if (server.builtin) {
      this.localDocker ??= new Docker({ socketPath: localDockerSocket() });
      return this.localDocker;
    }
    const client = await this.sshPool.get(server);
    return this.relay.get(id, client);
  }

  /** 服务器传输通道：远程 = SSH，本机 = 本地进程（无 SSH 依赖） */
  async transport(id: number): Promise<ServerTransport> {
    const server = await this.mustGet(id);
    if (server.builtin) return this.localTransport;
    // 远程：把 SshClient 收窄成窄接口（SFTP 在 remoteTransport 闭包里，见 transport.ts）
    return remoteTransport(await this.sshPool.get(server));
  }

  /** SSH 连接失效（断线）时丢弃缓存，下次 transport() 重建 */
  async dropSsh(id: number) {
    await this.sshPool.drop(id);
  }

  private async mustGet(id: number): Promise<Server> {
    const server = await this.repo.byId(id);
    if (!server) throw new ServiceError(`服务器不存在: ${id}`);
    return server;
  }
}

/** 本地 docker socket：尊重 DOCKER_HOST=unix://...，否则默认 /var/run/docker.sock */
function localDockerSocket(): string {
  const host = process.env.DOCKER_HOST;
  if (host?.startsWith("unix://")) return host.slice("unix://".length);
  return "/var/run/docker.sock";
}
