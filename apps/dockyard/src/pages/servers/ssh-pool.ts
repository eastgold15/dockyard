import { ServiceError } from "@elysiax/core";
import { readFileSync } from "node:fs";
import net from "node:net";
import { connect, acceptHostKeys, type Credential, type SshClient } from "@meitaim/ssh";
import { sshAgent } from "@meitaim/ssh/agent";
import type { Server } from "./schema";
import { decryptSecret } from "../../shared/crypto";

/** 首次连接未知主机：携带指纹让 UI 走 TOFU 确认流程 */
export class UnknownHostKeyError extends Error {
  constructor(
    public readonly fingerprint: string,
    public readonly algorithm: string,
  ) {
    super(`未知主机密钥: ${fingerprint}`);
  }
}

const IDLE_TTL_MS = 5 * 60 * 1000;

/** 把 node socket 包成 @meitaim/ssh 的 DuplexConnection（给 ssh-agent 用） */
function nodeSocketDuplex(socket: net.Socket) {
  return {
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        socket.on("data", (d) => controller.enqueue(new Uint8Array(d)));
        socket.on("end", () => controller.close());
        socket.on("error", (e) => controller.error(e));
      },
    }),
    write: (data: Uint8Array) =>
      new Promise<void>((resolve, reject) =>
        socket.write(data, (e) => (e ? reject(e) : resolve())),
      ),
  };
}

async function agentCredentials(): Promise<Credential[]> {
  const sockPath = Bun.env.SSH_AUTH_SOCK;
  if (!sockPath) throw new ServiceError("SSH_AUTH_SOCK 未设置（ssh-agent 不可用）");
  const socket = net.createConnection(sockPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const agent = sshAgent(nodeSocketDuplex(socket));
  const identities = await agent.identities();
  if (identities.length === 0) throw new ServiceError("ssh-agent 里没有可用密钥（先 ssh-add）");
  return identities.map((signer) => ({ signer }));
}

export class SshPool {
  private clients = new Map<number, { client: SshClient; timer: Timer }>();

  /** 获取（或建立）到某台服务器的连接；空闲 5 分钟自动断开 */
  async get(server: Server): Promise<SshClient> {
    const hit = this.clients.get(server.id);
    if (hit) {
      clearTimeout(hit.timer);
      hit.timer = setTimeout(() => this.drop(server.id), IDLE_TTL_MS);
      return hit.client;
    }
    const client = await this.connect(server);
    this.clients.set(server.id, {
      client,
      timer: setTimeout(() => this.drop(server.id), IDLE_TTL_MS),
    });
    return client;
  }

  /** 服务器配置变更 / 连接失效时调用 */
  async drop(serverId: number) {
    const hit = this.clients.get(serverId);
    this.clients.delete(serverId);
    if (hit) {
      clearTimeout(hit.timer);
      await hit.client.close().catch(() => {});
    }
  }

  private async connect(server: Server): Promise<SshClient> {
    let credential: Credential | { credentials: readonly Credential[] };
    if (server.authType === "password") {
      credential = { password: decryptSecret(server.password ?? "") };
    } else if (server.authType === "agent") {
      credential = { credentials: await agentCredentials() };
    } else {
      if (!server.keyPath) throw new ServiceError("未配置私钥路径");
      credential = { privateKey: readFileSync(server.keyPath, "utf8") };
    }

    // TOFU：已存指纹则严格校验；未存则拒绝并把指纹带给调用方
    let presented: { fingerprint: string; algorithm: string } | undefined;
    const verifyHostKey = server.hostKeyFingerprint
      ? acceptHostKeys(server.hostKeyFingerprint)
      : (key: { fingerprint: string; algorithm: string }) => {
          presented = key;
          return false;
        };

    try {
      return await connect({
        host: server.host,
        port: server.port,
        username: server.user,
        ...credential,
        // 跨网线路抖动大：握手 30s 超时 + 失败重试一次（keepAlive 15s 保活已开）
        timeout: 30_000,
        keepAlive: 15_000,
        verifyHostKey,
      });
    } catch (error) {
      if (presented) throw new UnknownHostKeyError(presented.fingerprint, presented.algorithm);
      throw error;
    }
  }
}
