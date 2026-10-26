import net from "node:net";
import { rmSync } from "node:fs";
import { join } from "node:path";
import Docker from "dockerode";
import type { SshClient } from "@meitaim/ssh";
import { appPaths } from "../../shared/paths";

/**
 * dockerode 走 SSH 中继：本地 unix socket 监听，每个入站连接开一条
 * direct-streamlocal 通道到远端 /var/run/docker.sock，双向泵数据。
 * 参考 openship docker-transport.ts 的 ssh 传输，但用 @meitaim/ssh。
 */
export class DockerRelay {
  private relays = new Map<number, { server: net.Server; socketPath: string }>();

  /** 远端 docker 的 dockerode 实例（按 serverId 复用中继） */
  async get(serverId: number, client: SshClient): Promise<Docker> {
    const hit = this.relays.get(serverId);
    if (hit) return new Docker({ socketPath: hit.socketPath });

    const socketPath = join(appPaths.relayDir, `server-${serverId}.sock`);
    rmSync(socketPath, { force: true });
    const server = net.createServer((socket) => {
      client
        .forwardToSocket("/var/run/docker.sock")
        .then(async (channel) => {
          // 远端 → 本地
          (async () => {
            try {
              for await (const chunk of channel.stdout) socket.write(chunk);
              socket.end();
            } catch {
              socket.destroy();
            }
          })();
          // 本地 → 远端
          socket.on("data", (d) => void channel.write(new Uint8Array(d)).catch(() => socket.destroy()));
          socket.on("end", () => void channel.end().catch(() => {}));
          socket.on("error", () => void channel.close().catch(() => {}));
        })
        .catch(() => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    this.relays.set(serverId, { server, socketPath });
    return new Docker({ socketPath });
  }

  drop(serverId: number) {
    const hit = this.relays.get(serverId);
    this.relays.delete(serverId);
    if (hit) {
      hit.server.close();
      rmSync(hit.socketPath, { force: true });
    }
  }
}
