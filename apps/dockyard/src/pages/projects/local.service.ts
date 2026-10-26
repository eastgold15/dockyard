import { ServiceError } from "@elysiax/core";
import { readdir } from "node:fs/promises";
import { join } from "@visulima/path";
import { expandHome, loadConfig, saveConfig } from "./config";
import { parseOwnerRepo } from "../github/github.socket";

/** 扫描发现的本地项目（磁盘为准，registeredId 非空 = 已落库） */
export interface LocalProject {
  name: string;
  path: string;
  hasGit: boolean;
  /** origin 解析出的 owner/repo（非 GitHub 或无 remote 时为空） */
  remote?: string;
  registeredId?: number;
}

/** 读 git remote origin（无 git/无 remote/非 GitHub 均返回 undefined） */
export async function readGitRemote(path: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "-C", path, "remote", "get-url", "origin"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const url = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return parseOwnerRepo(url);
  } catch {
    return undefined;
  }
}

const isProjectDir = async (path: string) => {
  const checks = await Promise.all([
    Bun.file(join(path, ".git", "HEAD")).exists(),
    Bun.file(join(path, "package.json")).exists(),
  ]);
  return checks.some(Boolean);
};

// GUI 直接起进程；TUI 编辑器与 lazygit 需要包一层终端
const GUI_EDITORS = ["code", "cursor", "zed", "windsurf", "subl"];
const TUI_EDITORS = ["nvim", "hx", "vim"];
const TERMINALS = ["ghostty", "alacritty", "kitty", "foot", "wezterm"];

export class LocalService {
  /** 浅扫一级子目录：含 .git 或 package.json 即识别为项目 */
  async scan(registered: { localPath: string | null; id: number }[]): Promise<LocalProject[]> {
    const { scanDirs } = await loadConfig();
    const byPath = new Map(registered.filter((r) => r.localPath).map((r) => [r.localPath!, r.id]));
    const found = new Map<string, LocalProject>();
    for (const dir of scanDirs.map(expandHome)) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // 目录不存在/不可读：跳过
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        const path = join(dir, e.name);
        if (found.has(path) || !(await isProjectDir(path))) continue;
        found.set(path, {
          name: e.name,
          path,
          hasGit: await Bun.file(join(path, ".git", "HEAD")).exists(),
          remote: await readGitRemote(path),
          registeredId: byPath.get(path),
        });
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 本机可用的编辑器 / 终端 / lazygit */
  async toolchain() {
    const [editors, terminals, lazygit] = await Promise.all([
      Promise.all([...GUI_EDITORS, ...TUI_EDITORS].map(async (e) => ((await Bun.which(e)) ? e : null))),
      Promise.all(TERMINALS.map(async (t) => ((await Bun.which(t)) ? t : null))),
      Bun.which("lazygit"),
    ]);
    const { defaultEditor } = await loadConfig();
    return {
      editors: editors.filter((e): e is string => Boolean(e)),
      terminal: terminals.find(Boolean) ?? null,
      lazygit: Boolean(lazygit),
      defaultEditor,
    };
  }

  /** 用编辑器打开目录；TUI 编辑器包终端。用过即设为默认 */
  async openEditor(path: string, editor: string) {
    const { terminal } = await this.toolchain();
    const cmd = TUI_EDITORS.includes(editor)
      ? terminal
        ? [terminal, "-e", editor, path]
        : null
      : [editor, path];
    if (!cmd) throw new ServiceError(`「${editor}」是终端编辑器，但未找到可用终端（${TERMINALS.join("/")}）`);
    this.spawnDetached(cmd);
    const cfg = await loadConfig();
    if (cfg.defaultEditor !== editor) await saveConfig({ ...cfg, defaultEditor: editor });
  }

  async openLazygit(path: string) {
    const { terminal, lazygit } = await this.toolchain();
    if (!lazygit) throw new ServiceError("未安装 lazygit");
    if (!terminal) throw new ServiceError(`未找到可用终端（${TERMINALS.join("/")}）`);
    this.spawnDetached([terminal, "-e", "lazygit", "-p", path]);
  }

  /** 拉起外部进程后立即脱离，不阻塞请求、不随服务退出被杀 */
  private spawnDetached(cmd: string[]) {
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    proc.unref();
  }
}
