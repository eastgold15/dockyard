import { ServiceError } from "@elysiax/core";
import type Docker from "dockerode";
import type { Server } from "./schema";
import { encryptSecret } from "../../shared/crypto";
import { SshPool, UnknownHostKeyError } from "./ssh-pool";
import { DockerRelay } from "./docker-relay";
import type { ServerRepository, NewServer } from "./servers.repository";

export type CheckResult =
  | { ok: true; dockerVersion: string; warning?: string }
  | { ok: false; reason: "docker-missing" | "ssh-failed"; message: string }
  | { ok: false; reason: "need-trust"; fingerprint: string; algorithm: string };

export class ServerService {
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

  create(input: NewServer) {
    return this.repo.create({
      ...input,
      password: input.password ? encryptSecret(input.password) : undefined,
    });
  }

  async remove(id: number) {
    await this.sshPool.drop(id);
    this.relay.drop(id);
    return this.repo.remove(id);
  }

  /** 连接 + docker 检测；未知主机密钥时返回 need-trust 走 TOFU 确认 */
  async check(id: number): Promise<CheckResult> {
    const server = await this.mustGet(id);
    try {
      const client = await this.sshPool.get(server);
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
      return { ok: false, reason: "ssh-failed", message: (error as Error).message };
    }
  }

  /** TOFU：确认指纹后落库并立即重新检测 */
  async trust(id: number, fingerprint: string): Promise<CheckResult> {
    await this.repo.update(id, { hostKeyFingerprint: fingerprint });
    await this.sshPool.drop(id);
    return this.check(id);
  }

  /** 远端安装 docker（get.docker.com 官方脚本），返回完整输出 */
  async installDocker(id: number): Promise<{ code: number; output: string }> {
    const server = await this.mustGet(id);
    const client = await this.sshPool.get(server);
    const { stdout, stderr, code } = await client.exec(
      "curl -fsSL https://get.docker.com | sh",
    );
    if (code === 0) await this.check(id);
    return { code: code ?? -1, output: `${stdout}\n${stderr}`.trim() };
  }

  /** 远端 dockerode（经 SSH 中继 socket） */
  async docker(id: number): Promise<Docker> {
    const server = await this.mustGet(id);
    const client = await this.sshPool.get(server);
    return this.relay.get(id, client);
  }

  async ssh(id: number) {
    const server = await this.mustGet(id);
    return this.sshPool.get(server);
  }

  /** SSH 连接失效（断线）时丢弃缓存，下次 ssh() 重建 */
  async dropSsh(id: number) {
    await this.sshPool.drop(id);
  }

  private async mustGet(id: number): Promise<Server> {
    const server = await this.repo.byId(id);
    if (!server) throw new ServiceError(`服务器不存在: ${id}`);
    return server;
  }
}
