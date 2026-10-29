import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ServiceError } from "@elysiax/core";
import type { AppPaths } from "../../../shared/paths";
import type { CanvasService } from "../../canvas/canvas.socket";
import { openServerSftp, type ServerService } from "../../servers/servers.socket";
// 父子之间也走插座：deploy 的服务经父原子插座引入
import type { DeployService } from "../deploy.socket";

/** POSIX 单引号转义：容器名/路径会拼进宿主 shell，用户输入必须先过这里 */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 各引擎的 dump 命令（在容器内执行）。postgres 带 --clean --if-exists：
 *  恢复时先 DROP 再 CREATE，才对「已有数据」的实例可重放。 */
export function dumpCommandFor(dbType: string): string {
  const dumpCmd: Record<string, string> = {
    postgres: 'pg_dumpall --clean --if-exists -U "${POSTGRES_USER:-postgres}"',
    mysql: 'mysqldump --all-databases -uroot -p"$MYSQL_ROOT_PASSWORD"',
    mongo: 'mongodump --archive -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD"',
    redis: "redis-cli save >/dev/null && cat /data/dump.rdb",
  };
  return dumpCmd[dbType] ?? dumpCmd.postgres!;
}

/**
 * 备份宿主命令：dump 先落临时文件再压缩。
 * 不能写成 `docker exec … | gzip | base64`——管道退出码只取最后一段，
 * dump 失败（容器不存在/认证失败）时 gzip/base64 依旧成功，会产出「空备份却报成功」。
 * 这里逐段判错 + 非空校验 + gzip -t 自检，任何一段失败都如实报错。
 */
export function backupHostCommand(dbType: string, container: string): string {
  return [
    'tmp=$(mktemp) && gz=$(mktemp) || exit 1',
    `trap 'rm -f "$tmp" "$gz"' EXIT`,
    `docker exec ${shq(container)} sh -c ${shq(dumpCommandFor(dbType))} > "$tmp" || exit $?`,
    '[ -s "$tmp" ] || { echo "dump 输出为空" >&2; exit 1; }',
    'gzip -c "$tmp" > "$gz" || exit $?',
    'gzip -t "$gz" || { echo "备份压缩损坏" >&2; exit 1; }',
    'base64 -w0 < "$gz"',
  ].join("\n");
}

/** 可自动恢复的引擎。mysql 的 --all-databases 含 mysql 系统库（恢复时重建 grants 风险大），
 *  redis 的 RDB 必须停容器换文件（卷名/项目名不确定），都留给手动恢复。 */
export const RESTORE_SUPPORT: Record<string, boolean> = {
  postgres: true,
  mysql: false,
  mongo: true,
  redis: false,
};

/**
 * 恢复宿主命令：先 `gzip -t` 完整校验备份（防半截文件），再灌进容器。
 * 不用 pipefail（远端 shell 不保证支持）：gzip 校验通过后，管道退出码即恢复工具退出码。
 *
 * postgres 用 `ON_ERROR_STOP=0`：pg_dumpall --clean 的 DROP ROLE/CREATE ROLE 在「以被 dump
 * 的角色连接」时必然报错（当前用户不能删除、角色已存在），库被占用时 DROP DATABASE 也会报错。
 * 这些是语句级错误，psql 继续执行，数据仍会被 DROP/CREATE 重放；连接/认证失败则退出码非 0。
 */
export function restoreHostCommand(opts: {
  dbType: string;
  file: string;
  container: string;
}): string {
  const inner: Record<string, string> = {
    postgres: 'sh -c \'psql -U "${POSTGRES_USER:-postgres}" -d postgres -v ON_ERROR_STOP=0\'',
    mongo: 'sh -c \'mongorestore --archive --drop -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD"\'',
  };
  const cmd = inner[opts.dbType];
  if (!cmd) throw new ServiceError(`${opts.dbType} 暂不支持自动恢复，请下载备份后手动执行`);
  return [
    'set -e',
    `[ -s ${shq(opts.file)} ] || { echo "备份文件为空" >&2; exit 1; }`,
    `gzip -t ${shq(opts.file)} || { echo "备份文件损坏（gzip 校验失败）" >&2; exit 1; }`,
    `gunzip -c ${shq(opts.file)} | docker exec -i ${shq(opts.container)} ${cmd}`,
  ].join("\n");
}

/**
 * 重放整库 dump 时必然出现的语句级错误（幂等噪声）：
 * 我们以 `POSTGRES_USER`（默认 postgres）连接并 psql，dump 里 `DROP ROLE postgres`
 * 必然撞上「当前用户不能删除」，随后的 `CREATE ROLE postgres` 又撞「已存在」。
 * 每次恢复固定冒出这两条——若计入告警，「恢复完成，N 条告警」就成了恒定假信号。
 */
const EXPECTED_REPLAY_ERRORS = [/^ERROR:\s+current user cannot be dropped/, /^ERROR:\s+role ".*" already exists/];

/**
 * 恢复输出里的**非预期**语句级告警条数（不含内容——dump 语句可能带口令哈希）。
 * psql 的语句级错误只走 stderr，所以调用方必须把 stderr 一并传进来。
 */
export function countRestoreWarnings(output: string): number {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(ERROR|FATAL):/.test(line))
    .filter((line) => !EXPECTED_REPLAY_ERRORS.some((re) => re.test(line))).length;
}

/**
 * 备份（嵌套原子）：db 实例的 dump → gzip → base64 → 本地落盘。
 * 恢复 = 先自动安全备份，再把备份灌回实例（破坏性操作，API 需显式 confirm）。
 * 逻辑库/应用服务暂无卷，不出 Tab。
 */
export class BackupService {
  /** 正在恢复的 targetId：与备份/部署互斥，避免两个恢复踩同一个宿主临时路径 */
  private readonly restoring = new Set<number>();

  constructor(
    private readonly deploy: DeployService,
    private readonly canvas: CanvasService,
    private readonly server: ServerService,
    private readonly paths: AppPaths,
  ) {}

  private backupsDir(targetId: number) {
    return join(this.paths.dataDir, "backups", `target-${targetId}`);
  }

  /** 已有备份列表（新→旧） */
  async backupsOf(targetId: number): Promise<{ file: string; size: number; at: Date }[]> {
    const dir = this.backupsDir(targetId);
    if (!existsSync(dir)) return [];
    const { readdir, stat } = await import("node:fs/promises");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql.gz") || f.endsWith(".dump.gz"));
    const rows = await Promise.all(files.map(async (file) => {
      const st = await stat(join(dir, file));
      return { file, size: st.size, at: st.mtime };
    }));
    return rows.sort((a, b) => b.at.getTime() - a.at.getTime());
  }

  /** 立即备份：远端容器内 dump → gzip → base64（二进制安全过 ssh exec 的文本通道）→ 本地落盘 */
  async backupNow(targetId: number): Promise<string> {
    // 部署/回滚中途容器正在重建：此刻 dump 得到的是偏斜快照，却会被当成可用备份留住
    if (this.deploy.isRunning(targetId)) throw new ServiceError("部署/回滚进行中，容器可能正在重建，请结束后再备份");
    const target = await this.deploy.targetById(targetId);
    if (!target || target.kind !== "db" || target.instanceOf) throw new ServiceError("只有数据库实例支持备份");
    const node = await this.canvas.byId(target.nodeId);
    if (!node) throw new ServiceError("画布节点不存在");
    const client = await this.server.transport(node.serverId);
    // 容器身份唯一真相 = target.containerName 列（创建时定死）；不再现算（体检病-3）
    if (!target.containerName) throw new ServiceError("数据库目标缺少容器名（旧数据？重建该目标）");
    const { stdout, stderr, code } = await client.exec(
      backupHostCommand(target.dbType ?? "", target.containerName),
    );
    if (code !== 0) throw new ServiceError(`备份失败：${stderr.trim() || `exit ${code}`}`);
    const bytes = Buffer.from(stdout.trim(), "base64");
    // 兜底：空文件不允许进备份列表（否则「恢复」会拿着废文件覆盖数据）
    if (bytes.length === 0) throw new ServiceError("备份失败：dump 输出为空");
    const dir = this.backupsDir(targetId);
    await mkdir(dir, { recursive: true });
    const ext = target.dbType === "mongo" || target.dbType === "redis" ? "dump.gz" : "sql.gz";
    const file = `${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
    await Bun.write(join(dir, file), bytes);
    return file;
  }

  /**
   * 从本地备份恢复实例。破坏性操作，纪律：
   * 1. 与部署/其他恢复互斥（容器被重建时灌数据会把实例写坏）；
   * 2. 先做一次「恢复前安全备份」，失败即中止（绝不无退路地覆盖数据）；
   * 3. 备份先 `gzip -t` 完整校验，再 SFTP 传到宿主灌进容器（ssh exec 是文本通道，不塞二进制）；
   * 4. 宿主临时文件无论成败都清掉（含口令哈希的整库 dump 不能留）。
   */
  async restore(targetId: number, file: string): Promise<{ safety: string; warnings: number }> {
    if (this.restoring.has(targetId)) throw new ServiceError("该实例正在恢复，请等待当前恢复结束");
    // 占位必须紧跟检查：中间隔着 await（查库/解析路径/建通道）时，双击或两个标签页
    // 会在窗口里双双通过检查，随后同时往同一实例灌数据
    this.restoring.add(targetId);
    try {
      if (this.deploy.isRunning(targetId)) throw new ServiceError("该目标正在部署/回滚，请等操作结束后再恢复");
      const target = await this.deploy.targetById(targetId);
      if (!target || target.kind !== "db" || target.instanceOf) throw new ServiceError("只有数据库实例支持恢复");
      const dbType = target.dbType ?? "";
      if (!RESTORE_SUPPORT[dbType]) throw new ServiceError(`${dbType} 暂不支持自动恢复，请下载备份后手动执行`);
      if (!target.containerName) throw new ServiceError("数据库目标缺少容器名（旧数据？重建该目标）");
      const abs = this.backupFilePath(targetId, file);
      if (!abs) throw new ServiceError("备份文件不存在或文件名非法");
      const node = await this.canvas.byId(target.nodeId);
      if (!node) throw new ServiceError("画布节点不存在");
      const client = await this.server.transport(node.serverId);
      // 1. 安全备份（容器不在运行会在此失败，正好挡住往死实例里灌数据）
      const safety = await this.backupNow(targetId);
      // 2. 传到宿主临时目录（0600：dump 含整库数据与口令哈希）
      const { stdout: homeOut } = await client.exec('printf %s "$HOME"');
      const home = homeOut.trim();
      if (!home) throw new ServiceError("无法解析远端家目录，恢复中止");
      const remoteDir = `${home}/dockyard/restore/${targetId}`;
      const remoteFile = `${remoteDir}/${file}`;
      await client.exec(`mkdir -p ${shq(remoteDir)}`);
      let result: { stdout: string; stderr: string; code: number | null } | undefined;
      try {
        const sftp = await openServerSftp(client);
        await sftp.write(remoteFile, new Uint8Array(await Bun.file(abs).arrayBuffer()));
        await sftp.close();
        await client.exec(`chmod 600 ${shq(remoteFile)}`);
        // 3. 灌回容器
        result = await client.exec(restoreHostCommand({ dbType, file: remoteFile, container: target.containerName }));
      } finally {
        await client.exec(`rm -f ${shq(remoteFile)}`).catch(() => {});
      }
      if (!result) throw new ServiceError(`恢复失败：远端命令未返回结果\n（恢复前安全备份：${safety}）`);
      if (result.code !== 0) {
        const tail = (result.stderr || result.stdout).trim().slice(-2000) || `exit ${result.code}`;
        throw new ServiceError(`恢复失败：${tail}\n（恢复前安全备份：${safety}）`);
      }
      // psql 对语句级错误不中断：条数如实上报，别把「有一堆 ERROR」说成干净恢复
      return { safety, warnings: countRestoreWarnings(result.stderr + result.stdout) };
    } finally {
      this.restoring.delete(targetId);
    }
  }

  /** 备份文件绝对路径（防目录穿越：只认 backupsDir 下的纯文件名） */
  backupFilePath(targetId: number, file: string): string | null {
    if (!/^[\w.-]+\.(sql|dump)\.gz$/.test(file)) return null;
    const abs = join(this.backupsDir(targetId), file);
    return existsSync(abs) ? abs : null;
  }
}
