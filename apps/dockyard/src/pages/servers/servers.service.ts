import { ServiceError } from "@elysiax/core";
import Docker from "dockerode";
import { userInfo } from "node:os";
import type { Server } from "./schema";
import { encryptSecret } from "../../shared/crypto";
import { isLocalHost } from "./host";
import { SshPool, UnknownHostKeyError } from "./ssh-pool";
import { DockerRelay } from "./docker-relay";
import { LocalTransport, openServerSftp, remoteTransport, type ServerTransport } from "./transport";
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
   * - 存量「默认形态的本机行」（老版本用户添加的 localhost:22、当前用户）：
   *   原地升级为内置行，保留 id → 画布卡/部署目标的外键不断；
   * - 都没有：新建一行。
   *
   * 不能见回环就抢：`pori@127.0.0.1:2222` 是用户自己的 SSH 隧道，升级会把
   * host/port/user 全部改掉、还钉上 builtin=1 不可删。只认端口 22 + 当前用户
   * 这种「与本地进程等价」的行（同机同用户，改走本地通道没有语义变化）。
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
    const me = userInfo().username;
    const own =
      all.find((s) => s.builtin) ??
      all.find((s) => isLocalHost(s.host) && s.port === LOCAL_PORT && s.user === me);
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
      const { stdout, stderr, code } = await client.exec(
        "docker version --format '{{.Server.Version}}'",
      );
      if (code !== 0) {
        await this.repo.update(id, { dockerStatus: "missing", lastCheckedAt: new Date() });
        // 本机没有 SSH 这层：失败可能是 daemon 没跑 / 当前用户不在 docker 组，
        // 说成「远端未安装」会把用户引去装第二遍 docker。把 stderr 末行带出来。
        const detail = stderr.trim().split("\n").at(-1) ?? "";
        return {
          ok: false,
          reason: "docker-missing",
          message: server.builtin
            ? `本机 docker 不可用（daemon 未运行或当前用户无权访问${detail ? `：${detail}` : ""}）`
            : "远端未安装 docker",
        };
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

  /**
   * 保存镜像源设置；列表非空时立即应用到远端（写 /etc/docker/daemon.json + 重启 dockerd）。
   * 清空列表只保存不碰远端——不留 dockyard 去拆掉用户手工配的镜像源。
   */
  async configureMirrors(
    id: number,
    text: string,
  ): Promise<{ applied: boolean; mirrors: string[]; output: string }> {
    const server = await this.mustGet(id);
    if (server.builtin)
      throw new ServiceError("本机镜像源由本机 daemon 配置管理，不需要在 dockyard 里应用");
    const mirrors = normalizeMirrors(text);
    await this.repo.update(id, {
      registryMirrors: mirrors.length ? JSON.stringify(mirrors) : null,
    });
    if (mirrors.length === 0)
      return { applied: false, mirrors: [], output: "镜像源已清空（仅保存设置，未触碰远端 daemon.json）" };
    const client = await this.transport(id);
    const final = await applyMirrorsToServer(client, mirrors);
    // dockerd 重启后立刻探测可能撞上 daemon 还没起来（systemctl 阻塞等待则首轮就成功）；
    // 失败时短重试，避免状态被误标成「无 docker」
    for (let i = 0; i < 3; i++) {
      const probe = await this.check(id);
      if (probe.ok) break;
      await new Promise((r) => setTimeout(r, 600));
    }
    return {
      applied: true,
      mirrors: final,
      output: `镜像源已写入远端 /etc/docker/daemon.json 并重启 docker\n当前生效：\n${final.join("\n")}`,
    };
  }

  /** 远端 dockerode（经 SSH 中继 socket）；本机直连本地 docker daemon */
  async docker(id: number): Promise<Docker> {
    const server = await this.mustGet(id);
    if (server.builtin) {
      // 不传 socketPath：dockerode 自己读 DOCKER_HOST（unix/tcp/ssh/npipe），
      // 无环境变量时用 findDefaultUnixSocket（含 Docker Desktop 的
      // ~/.docker/run/docker.sock）。硬钉 /var/run/docker.sock 会连错 daemon。
      this.localDocker ??= new Docker();
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

// ── 镜像源：纯函数段（单测覆盖），apply 的远端副作用收敛到 applyMirrorsToServer ──

/** 表单行文本 → 归一化镜像源列表：补 https://、去空行/尾斜杠/重复；非法 URL 直接拒绝 */
export function normalizeMirrors(text: string): string[] {
  const mirrors: string[] = [];
  for (const line of text.split("\n")) {
    const raw = line.trim();
    if (!raw) continue;
    // dockerd 强制要求镜像源带 scheme；用户常只填主机名，统一按 HTTPS 补全
    const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ServiceError(`非法镜像源地址：${raw}`);
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname)
      throw new ServiceError(`镜像源只支持 http(s) 地址：${raw}`);
    const normalized = value.replace(/\/+$/, "");
    if (!mirrors.includes(normalized)) mirrors.push(normalized);
  }
  return mirrors;
}

/** DB 存的是 JSON 数组字符串；解析失败/空值一律当 [] 处理（存量行没有该列） */
export function parseMirrors(server: Pick<Server, "registryMirrors">): string[] {
  if (!server.registryMirrors) return [];
  try {
    const arr = JSON.parse(server.registryMirrors) as unknown;
    return Array.isArray(arr)
      ? arr.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

/** 现有 daemon.json + dockyard 配置 → 合并后的 JSON 文本。
 *  只追加不覆盖（保留用户在远端手工配的其他镜像源/配置项），去重后写回。 */
export function mergeRegistryMirrors(existing: unknown, mirrors: string[]): string {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const cur = Array.isArray(base["registry-mirrors"])
    ? (base["registry-mirrors"] as unknown[]).filter((m): m is string => typeof m === "string")
    : [];
  // 新增列表逐条并入并去重：既不能覆盖远端原有镜像源，新列表内部也不能出现重复
  const merged: string[] = [...cur];
  for (const m of mirrors) if (!merged.includes(m)) merged.push(m);
  return JSON.stringify({ ...base, "registry-mirrors": merged }, null, 2) + "\n";
}

/** 把镜像源应用到远端传输通道：探测 root/sudo → 读 daemon.json → 合并写回 → 重启 dockerd。
 *  返回最终生效的 registry-mirrors 列表（含远端原有的，供 UI 展示核对）。 */
export async function applyMirrorsToServer(client: ServerTransport, mirrors: string[]): Promise<string[]> {
  const normalized = normalizeMirrors(mirrors.join("\n"));
  if (normalized.length === 0) throw new ServiceError("镜像源列表为空，没有可应用的内容");

  const uid = await client.exec("id -u");
  const isRoot = uid.code === 0 && uid.stdout.trim() === "0";
  const prefix = isRoot ? "" : "sudo ";
  if (!isRoot) {
    const sudoOk = await client.exec("sudo -n true 2>/dev/null");
    if (sudoOk.code !== 0)
      throw new ServiceError("远端用户非 root 且没有免密 sudo，无法写 /etc/docker/daemon.json");
  }

  // 非 root 时读取也要走 sudo；读失败必须中止，不能当成空配置覆盖原文件
  const raw = await client.exec(
    `if [ -f /etc/docker/daemon.json ]; then ${prefix}cat /etc/docker/daemon.json; else printf '{}'; fi`,
  );
  if (raw.code !== 0) throw new ServiceError(`读取远端 daemon.json 失败：${raw.stderr || raw.stdout}`);
  let existing: unknown = {};
  try {
    existing = JSON.parse(raw.stdout.trim() || "{}");
  } catch {
    throw new ServiceError(`远端 /etc/docker/daemon.json 不是合法 JSON，拒绝覆盖：${raw.stdout.trim().slice(0, 160)}`);
  }
  const next = mergeRegistryMirrors(existing, normalized);

  // 先把候选配置写到 /tmp，由 dockerd 自己校验；不通过时原配置和 docker 都不动
  const sftp = await client.sftp();
  await sftp.write("/tmp/dockyard-daemon.json", next);
  await sftp.close();
  const validation = await client.exec(`${prefix}dockerd --validate --config-file=/tmp/dockyard-daemon.json`);
  if (validation.code !== 0) {
    await client.exec("rm -f /tmp/dockyard-daemon.json");
    throw new ServiceError(`dockerd 配置校验失败，未修改远端配置：${validation.stderr || validation.stdout}`);
  }

  // 备份 → 同目录临时文件原子替换 → 重启。重启失败则恢复备份（原先无文件则删除新文件）
  // 并尝试重新拉起 docker，绝不把服务器留在「配置已覆盖 + daemon 停止」的状态。
  const apply = await client.exec(
    [
      "set -e",
      'backup="/etc/docker/daemon.json.dockyard-bak-$(date +%Y%m%d%H%M%S)-$$"',
      "had_config=0",
      "restart_docker() {",
      "  if command -v systemctl >/dev/null 2>&1; then",
      `    ${prefix}systemctl restart docker`,
      "  else",
      `    ${prefix}service docker restart`,
      "  fi",
      "}",
      "if [ -f /etc/docker/daemon.json ]; then",
      `  ${prefix}cp -a /etc/docker/daemon.json "$backup"`,
      "  had_config=1",
      "fi",
      `${prefix}install -m 644 -o root -g root /tmp/dockyard-daemon.json /etc/docker/.daemon.json.dockyard-new`,
      `${prefix}mv /etc/docker/.daemon.json.dockyard-new /etc/docker/daemon.json`,
      "if ! restart_docker; then",
      '  if [ "$had_config" = 1 ]; then',
      `    ${prefix}cp -a "$backup" /etc/docker/.daemon.json.dockyard-new`,
      `    ${prefix}mv /etc/docker/.daemon.json.dockyard-new /etc/docker/daemon.json`,
      "  else",
      `    ${prefix}rm -f /etc/docker/daemon.json`,
      "  fi",
      "  restart_docker || true",
      "  rm -f /tmp/dockyard-daemon.json",
      "  exit 1",
      "fi",
      "rm -f /tmp/dockyard-daemon.json",
    ].join("\n"),
  );
  if (apply.code !== 0)
    throw new ServiceError(`应用镜像源失败（已自动恢复原配置并尝试重启）：${apply.stderr || apply.stdout}`);

  const final = (JSON.parse(next) as { "registry-mirrors": unknown[] })["registry-mirrors"];
  return (final ?? []).map((m) => String(m));
}
