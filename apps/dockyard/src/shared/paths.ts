
import { ensureDirSync } from "@visulima/fs";
import { join } from "@visulima/path";

// 数据目录：装进 /usr/bin 后 cwd 不可写，必须走 XDG
const dataHome = Bun.env.XDG_DATA_HOME ?? join(Bun.env.HOME ?? ".", ".local", "share");
const cacheHome = Bun.env.XDG_CACHE_HOME ?? join(Bun.env.HOME ?? ".", ".cache");

export const appPaths = {
  dataDir: join(dataHome, "dockyard"),
  cacheDir: join(cacheHome, "dockyard"),
  get dbFile() { return join(this.dataDir, "dockyard.db"); },
  /** 加密密钥文件（0600） */
  get secretFile() { return join(this.dataDir, "secret"); },
  /** git 仓库缓存 */
  get reposDir() { return join(this.cacheDir, "repos"); },
  /** dockerode 中继 unix socket 目录 */
  get relayDir() { return join(this.cacheDir, "relay"); },
} as const;

export type AppPaths = typeof appPaths;

// 必须是同步的：db.ts 在模块顶层打开 SQLite，异步创建目录会与打开形成竞态
// （全新 XDG 数据目录上直接 SQLITE_CANTOPEN）
export function ensureDirs() {
  for (const dir of [appPaths.dataDir, appPaths.cacheDir, appPaths.reposDir, appPaths.relayDir]) {
    ensureDirSync(dir);
  }
}
