import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 用户级配置（机器相关，不进仓库）：项目扫描目录、默认编辑器。
 * 遵循 XDG：~/.config/dockyard/config.json
 */
const configHome = Bun.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
export const configFile = join(configHome, "dockyard", "config.json");

export interface DockyardConfig {
  /** 项目扫描目录（支持 ~/ 前缀），浅扫一级子目录 */
  scanDirs: string[];
  /** 默认编辑器（每用一次某个编辑器打开就更新为它） */
  defaultEditor: string;
}

const defaults = (): DockyardConfig => ({
  scanDirs: [join(homedir(), "Documents", "GitHub")],
  defaultEditor: "",
});

export async function loadConfig(): Promise<DockyardConfig> {
  try {
    const raw = (await Bun.file(configFile).json()) as Partial<DockyardConfig>;
    return { ...defaults(), ...raw };
  } catch {
    return defaults();
  }
}

/** Bun.write 会自动创建父目录 */
export function saveConfig(cfg: DockyardConfig) {
  return Bun.write(configFile, `${JSON.stringify(cfg, null, 2)}\n`);
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}
