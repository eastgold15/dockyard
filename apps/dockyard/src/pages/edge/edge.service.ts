/**
 * edge 上下文：每台服务器一个 dockyard-edge 容器（caddy:2-alpine，host 网络占 80/443），
 * 把「域名 → 127.0.0.1:端口」的路由全量推进 Caddy admin API（/load 原子生效，无需 reload）。
 * 证书由 Caddy 自动 ACME（http-01 走 80 端口），dnsStatus/sslStatus 是我们探测出的状态机：
 * - dnsStatus：控制机 resolve4 域名 vs 服务器 host
 * - sslStatus：服务器上 curl --resolve 把域名钉到 127.0.0.1 做 TLS 握手探测
 * openship 用 OpenResty + certbot 文件管线是因为它要 Lua 规则引擎；这里 Caddy 的
 * admin API 动态路由足够，省掉 vhost 渲染/reload/证书状态机一整层。
 */
import { ServiceError } from "@elysiax/core";
import { resolve4 } from "node:dns/promises";
import { openSftp } from "@meitaim/ssh/sftp";
import type { Domain } from "./schema";
import type { EdgeRepository } from "./edge.repository";
import type { ServerService } from "../servers/servers.socket";

export const EDGE_CONTAINER = "dockyard-edge";
const EDGE_CONFIG_PATH = "/tmp/dockyard-edge-caddy.json";
const ADMIN_URL = "http://127.0.0.1:2019";

type Log = (line: string) => Promise<void>;
const noopLog: Log = async () => {};

/** 域名列表 → 完整 Caddy JSON 配置（/load 是全量替换语义） */
export function caddyConfig(rows: Pick<Domain, "hostname" | "targetPort">[]): string {
  const routes = rows.map((d) => ({
    match: [{ host: [d.hostname] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: `127.0.0.1:${d.targetPort}` }],
      },
    ],
    terminal: true,
  }));
  return JSON.stringify({
    admin: { listen: "127.0.0.1:2019" },
    apps: {
      http: {
        servers: {
          dockyard: { listen: [":443"], routes },
        },
      },
    },
  });
}

export class EdgeService {
  constructor(
    private readonly repo: EdgeRepository,
    private readonly serverService: ServerService,
  ) {}

  domainsOfTarget(targetId: number) {
    return this.repo.domainsOfTarget(targetId);
  }

  domainById(id: number) {
    return this.repo.domainById(id);
  }

  /** 绑定域名：只有 app 目标能绑；hostname 全局抢占检查（抢别人的域名是大事故） */
  async addDomain(targetId: number, input: { hostname: string; targetPort: number; serviceName?: string }) {
    const target = await this.repo.targetBrief(targetId);
    if (!target || target.kind !== "app") throw new ServiceError("只有 app 目标能绑域名");
    const taken = await this.repo.domainByHostname(input.hostname);
    if (taken) {
      const owner = await this.repo.targetBrief(taken.targetId);
      throw new ServiceError(`域名 ${input.hostname} 已被「${owner?.name ?? `#${taken.targetId}`}」占用`);
    }
    return this.repo.addDomain({ targetId, ...input });
  }

  removeDomain(id: number) {
    return this.repo.removeDomain(id);
  }

  /**
   * 全量对账：某台服务器上的域名行 → edge 容器 → Caddy 路由 → 状态回写。
   * 部署 app / 增删域名后调用。零域名时撤掉 edge（不白占 80/443）。
   */
  async syncServer(serverId: number, log: Log = noopLog): Promise<void> {
    const rows = await this.repo.domainsOfServer(serverId);
    if (rows.length === 0) {
      await this.teardown(serverId, log);
      return;
    }
    await this.checkDns(serverId, rows, log);
    await this.ensureEdge(serverId, log);
    const active = rows.filter((d) => d.dnsStatus !== "mismatch");
    if (active.length < rows.length) {
      await log("以下域名 DNS 未指向本机，先不挂路由（解析生效后重新同步即可）：");
      for (const d of rows.filter((d) => d.dnsStatus === "mismatch")) await log(`  ⚠️ ${d.hostname}`);
    }
    const client = await this.serverService.ssh(serverId);
    const sftp = await openSftp(client);
    await sftp.write(EDGE_CONFIG_PATH, caddyConfig(active));
    await sftp.close();
    const load = await client.exec(
      `curl -sf -X POST -H 'Content-Type: application/json' -d @${EDGE_CONFIG_PATH} ${ADMIN_URL}/load`,
    );
    if (load.code !== 0) throw new ServiceError(`Caddy 配置推送失败：${load.stderr || load.stdout}`);
    await log(`edge 路由已生效：${active.map((d) => `${d.hostname} → :${d.targetPort}`).join("，")}`);
    await this.probeSsl(serverId, active, log);
  }

  /** edge 容器不存在则创建（80/443 被占会给出明确报错） */
  private async ensureEdge(serverId: number, log: Log): Promise<void> {
    const remote = await this.serverService.docker(serverId);
    const containers = await remote.listContainers({ all: true });
    const hit = containers.find((c) => c.Names.includes(`/${EDGE_CONTAINER}`));
    if (hit) {
      if (hit.Labels?.["dockyard.managed"] !== "true")
        throw new ServiceError(`远端存在非本工具管理的容器 ${EDGE_CONTAINER}，已阻止`);
      if (hit.State !== "running") {
        await log("启动已有 edge 容器 …");
        await remote.getContainer(hit.Id).start();
      }
      return;
    }
    // 建之前确认 80/443 没被别的进程占（host 网络直接冲突）
    const client = await this.serverService.ssh(serverId);
    const busy = await client.exec("ss -tln | grep -E ':(80|443) ' || true");
    if (busy.stdout.trim())
      throw new ServiceError(`服务器 80/443 端口被占用，无法启动 edge：\n${busy.stdout.trim()}`);

    await log("拉取 caddy:2-alpine …");
    await new Promise<void>((resolve, reject) => {
      void remote.pull("caddy:2-alpine", (err: Error | null, stream?: NodeJS.ReadableStream) => {
        if (err || !stream) return reject(err ?? new Error("pull 失败"));
        remote.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve()));
      });
    });
    await log("创建 edge 容器（host 网络，80/443）…");
    const container = await remote.createContainer({
      Image: "caddy:2-alpine",
      name: EDGE_CONTAINER,
      Labels: {
        "dockyard.managed": "true",
        "dockyard.target-id": "edge",
        "dockyard.project": "dockyard-edge",
      },
      HostConfig: {
        NetworkMode: "host",
        RestartPolicy: { Name: "unless-stopped" },
        // 证书/数据持久化，重建容器不重签
        Binds: ["dockyard-edge-data:/data", "dockyard-edge-config:/config"],
      },
    });
    await container.start();
  }

  /** 零域名时撤掉 edge（只动带我们标签的容器） */
  private async teardown(serverId: number, log: Log): Promise<void> {
    const remote = await this.serverService.docker(serverId);
    const containers = await remote.listContainers({ all: true });
    const hit = containers.find((c) => c.Names.includes(`/${EDGE_CONTAINER}`));
    if (!hit || hit.Labels?.["dockyard.managed"] !== "true") return;
    await log("已无域名绑定，停止 edge 容器");
    const container = remote.getContainer(hit.Id);
    if (hit.State === "running") await container.stop();
    await container.remove();
  }

  /** DNS 对账：域名解析 IP 里有没有服务器 host（host 本身是域名则先解析一次） */
  private async checkDns(serverId: number, rows: Domain[], log: Log): Promise<void> {
    const server = await this.serverService.byId(serverId);
    if (!server) return;
    const serverIps = await resolveIps(server.host);
    for (const d of rows) {
      const ips = await resolveIps(d.hostname);
      const ok = ips.length > 0 && ips.some((ip) => serverIps.includes(ip));
      const status = ok ? "ok" : "mismatch";
      if (d.dnsStatus !== status) await this.repo.updateDomain(d.id, { dnsStatus: status });
      d.dnsStatus = status;
      if (!ok) await log(`DNS 检查：${d.hostname} → ${ips.join(", ") || "（无解析）"}，与本机 ${server.host} 不符`);
    }
  }

  /** TLS 探测：服务器上把域名钉到 127.0.0.1 发 HTTPS 请求，握手过 = 证书已签发 */
  private async probeSsl(serverId: number, rows: Domain[], log: Log): Promise<void> {
    const client = await this.serverService.ssh(serverId);
    for (const d of rows) {
      // --resolve 钉住本机，测的是 edge 的证书而不是公网链路；证书未签发时 Caddy 握手即失败
      const probe = await client.exec(
        `curl -s -o /dev/null -m 8 -w '%{http_code}' --resolve ${d.hostname}:443:127.0.0.1 https://${d.hostname}/ || true`,
      );
      const ok = probe.code === 0 && /^\d{3}$/.test(probe.stdout.trim()) && probe.stdout.trim() !== "000";
      const status = ok ? "active" : "pending";
      if (d.sslStatus !== status) {
        await this.repo.updateDomain(d.id, {
          sslStatus: status,
          sslError: ok ? null : "证书尚未签发（Caddy 会在首次公网访问时自动完成 ACME）",
        });
      }
      await log(ok ? `🔒 ${d.hostname} 证书就绪` : `⏳ ${d.hostname} 证书待签发（首次公网 HTTPS 访问触发）`);
    }
  }
}

async function resolveIps(host: string): Promise<string[]> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return [host];
  try {
    return await resolve4(host);
  } catch {
    return [];
  }
}
