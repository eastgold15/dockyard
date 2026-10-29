import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ServiceError } from "@elysiax/core";
import type { AppPaths } from "../../../shared/paths";
import type { CanvasService } from "../../canvas/canvas.socket";
import { openServerSftp, type ServerService } from "../../servers/servers.socket";
// 父子之间也走插座：deploy 的服务经父原子插座引入
import type { DeployService } from "../deploy.socket";

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

/** 可自动恢复的引擎。mysql 的 --all-databases 含 mysql 系统库（恢复时重建 grants 风险大），
 *  redis 的 RDB 必须停容器换文件（卷名/项目名不确定），都留给手动恢复。 */
export const RESTORE_SUPPORT: Record<string, boolean> = {
  postgres: true,
  mysql: false,
  mongo: true,
  redis: false,
};

/** 恢复命令（远端宿主执行）：把本地备份 SFTP 传上去后，gunzip | docker exec -i 灌进容器。
 *  凭据走容器内环境变量（docker exec 不会展开宿主变量，所以套一层 sh -c）。 */
export function restorePipeCommand(opts: { dbType: string; file: string; container: string }): string {
  const inner: Record<string, string> = {
    // ON_ERROR_STOP=1：--clean 的备份不该有报错；旧备份（无 DROP）会在这里快速失败而不是灌半截
    postgres: 'sh -c \'psql -U "${POSTGRES_USER:-postgres}" -d postgres -v ON_ERROR_STOP=1\'',
    mongo: 'sh -c \'mongorestore --archive --drop -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD"\'',
  };
  const cmd = inner[opts.dbType];
  if (!cmd) throw new ServiceError(`${opts.dbType} 暂不支持自动恢复，请下载备份后手动执行`);
  return `gunzip -c "${opts.file}" | docker exec -i ${opts.container} ${cmd}`;
}

/**
 * 备份（嵌套原子）：db 实例的 dump → gzip → base64 → 本地落盘。
 * 恢复 = 先自动安全备份，再把备份灌回实例（破坏性操作，API 需显式 confirm）。
 * 逻辑库/应用服务暂无卷，不出 Tab。
 */
export class BackupService {
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
    const target = await this.deploy.targetById(targetId);
    if (!target || target.kind !== "db" || target.instanceOf) throw new ServiceError("只有数据库实例支持备份");
    const cmd = dumpCommandFor(target.dbType ?? "");
    const node = await this.canvas.byId(target.nodeId);
    if (!node) throw new ServiceError("画布节点不存在");
    const client = await this.server.transport(node.serverId);
    // 容器身份唯一真相 = target.containerName 列（创建时定死）；不再现算（体检病-3）
    if (!target.containerName) throw new ServiceError("数据库目标缺少容器名（旧数据？重建该目标）");
    const container = target.containerName;
    const { stdout, stderr, code } = await client.exec(
      `docker exec ${container} sh -c '${cmd}' | gzip | base64 -w0`,
    );
    if (code !== 0) throw new ServiceError(`备份失败：${stderr.trim() || `exit ${code}`}`);
    const dir = this.backupsDir(targetId);
    await mkdir(dir, { recursive: true });
    const ext = target.dbType === "mongo" || target.dbType === "redis" ? "dump.gz" : "sql.gz";
    const file = `${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
    await Bun.write(join(dir, file), Buffer.from(stdout.trim(), "base64"));
    return file;
  }

  /**
   * 从本地备份恢复实例。破坏性操作，纪律：
   * 1. 先做一次「恢复前安全备份」，失败即中止（绝不无退路地覆盖数据）；
   * 2. 备份经 SFTP 传到宿主再 gunzip | docker exec -i 灌进容器（ssh exec 是文本通道，不塞二进制）；
   * 3. 只支持可重放 dump 的引擎（见 RESTORE_SUPPORT），不支持的直接拒绝并提示手动执行。
   */
  async restore(targetId: number, file: string): Promise<{ safety: string }> {
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
    // 2. 传到宿主临时目录
    const { stdout: homeOut } = await client.exec('printf %s "$HOME"');
    const remoteFile = `${homeOut.trim()}/dockyard/restore/${targetId}/${file}`;
    await client.exec(`mkdir -p "${homeOut.trim()}/dockyard/restore/${targetId}"`);
    const sftp = await openServerSftp(client);
    await sftp.write(remoteFile, new Uint8Array(await Bun.file(abs).arrayBuffer()));
    await sftp.close();
    // 3. 灌回容器；无论成败都清掉宿主上的临时文件
    const { stdout, stderr, code } = await client.exec(
      restorePipeCommand({ dbType, file: remoteFile, container: target.containerName }),
    );
    await client.exec(`rm -f "${remoteFile}"`);
    if (code !== 0) {
      const tail = (stderr || stdout).trim().slice(-2000) || `exit ${code}`;
      throw new ServiceError(`恢复失败：${tail}\n（恢复前安全备份：${safety}）`);
    }
    return { safety };
  }

  /** 备份文件绝对路径（防目录穿越：只认 backupsDir 下的纯文件名） */
  backupFilePath(targetId: number, file: string): string | null {
    if (!/^[\w.-]+\.(sql|dump)\.gz$/.test(file)) return null;
    const abs = join(this.backupsDir(targetId), file);
    return existsSync(abs) ? abs : null;
  }
}
