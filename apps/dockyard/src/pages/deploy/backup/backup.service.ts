import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ServiceError } from "@elysiax/core";
import type { AppPaths } from "../../../shared/paths";
import { containerNameOf } from "../../resources/resources.socket";
import type { CanvasService } from "../../canvas/canvas.socket";
import type { ServerService } from "../../servers/servers.socket";
// 父子之间也走插座：deploy 的服务经父原子插座引入
import type { DeployService } from "../deploy.socket";

/**
 * 备份（嵌套原子）：db 实例的 dump → gzip → base64 → 本地落盘。
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
    const dumpCmd: Record<string, string> = {
      postgres: 'pg_dumpall -U "${POSTGRES_USER:-postgres}"',
      mysql: 'mysqldump --all-databases -uroot -p"$MYSQL_ROOT_PASSWORD"',
      mongo: 'mongodump --archive -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD"',
      redis: "redis-cli save >/dev/null && cat /data/dump.rdb",
    };
    const cmd = dumpCmd[target.dbType ?? ""] ?? dumpCmd.postgres!;
    const node = await this.canvas.byId(target.nodeId);
    if (!node) throw new ServiceError("画布节点不存在");
    const client = await this.server.ssh(node.serverId);
    const container = containerNameOf(target.id, target.name);
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

  /** 备份文件绝对路径（防目录穿越：只认 backupsDir 下的纯文件名） */
  backupFilePath(targetId: number, file: string): string | null {
    if (!/^[\w.-]+\.(sql|dump)\.gz$/.test(file)) return null;
    const abs = join(this.backupsDir(targetId), file);
    return existsSync(abs) ? abs : null;
  }
}
