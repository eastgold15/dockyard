import { defineRoutes } from "../../../.elysiax";
import { routes } from "../../../.elysiax";
import type { Component } from "@elysiax/htmx";
import type { Project } from "./schema";
import { configFile, loadConfig } from "./config";
import type { RepoBrief } from "../github/github.socket";
import type { LocalProject, LocalService } from "./local.service";
import type { ProjectService } from "./projects.service";
import { Button, Empty, Modal, PageHeader } from "../../shared/ui";

export interface ProjectListModel {
  local: LocalProject[];
  /** 绑定了 GitHub 仓库但不在本地扫描结果里的项目空间 */
  remote: Project[];
  editors: string[];
  defaultEditor: string;
  lazygit: boolean;
}

interface ModelCtx {
  project: ProjectService;
  local: LocalService;
}

/** 列表视图模型：本地扫描结果（磁盘为准）+ 未检出的 GitHub 项目空间 */
export async function listModel(ctx: ModelCtx): Promise<ProjectListModel> {
  const [projects, toolchain] = await Promise.all([ctx.project.list(), ctx.local.toolchain()]);
  const local = await ctx.local.scan(projects);
  const localPaths = new Set(local.map((p) => p.path));
  return {
    local,
    remote: projects.filter((p) => !p.localPath || !localPaths.has(p.localPath)),
    ...toolchain,
  };
}

/** 编辑器 split-button：主按钮 = 默认编辑器直接开；下拉换一个（服务端会把它记为新默认） */
const EditorPicker: Component<{ path: string; editors: string[]; defaultEditor: string }> = ({
  path,
  editors,
  defaultEditor,
}) => {
  if (editors.length === 0) return <></>;
  const current = editors.includes(defaultEditor) ? defaultEditor : editors[0]!;
  const vals = `js:{path:${JSON.stringify(path)}}`;
  return (
    <div class="flex items-center" {...{ onclick: "event.stopPropagation()" }}>
      <button
        class="rounded-l border border-harbor-700 px-2.5 py-1 text-xs text-neutral-300 transition-colors hover:bg-harbor-800 hover:text-brass-500"
        hx-post={routes.pages.projects.open()}
        hx-vals={`js:{path:${JSON.stringify(path)},tool:${JSON.stringify(current)}}`}
        hx-swap="none"
        {...{ "hx-on::response-error": "alert(event.detail.xhr.responseText)" }}
      >
        {current} 打开
      </button>
      <select
        class="-ml-px rounded-r border border-harbor-700 bg-harbor-900 px-1 py-1 text-xs text-neutral-500 outline-none hover:text-neutral-300"
        name="tool"
        hx-post={routes.pages.projects.open()}
        hx-trigger="change"
        hx-vals={vals}
        hx-swap="none"
        title="选择编辑器（选中即设为默认）"
        {...{ "hx-on::response-error": "alert(event.detail.xhr.responseText)" }}
      >
        {editors.map((e) => (
          <option value={e} selected={e === current}>
            {e}
          </option>
        ))}
      </select>
    </div>
  );
};

/** 项目列表（页面主体，也是删除/保存后的刷新片段——片段与页面同源） */
export const ProjectList: Component<ProjectListModel> = ({ local, remote, editors, defaultEditor, lazygit }) => (
  <div class="flex h-full flex-col">
    <PageHeader title="项目" sub={`本地 ${local.length} · 远程 ${remote.length}`}>
      <Button label="⚙ 扫描目录" variant="ghost" hxGet={routes.pages.projects.config()} hxTarget="#modal-root" hxSwap="innerHTML" />
      <Button label="＋ 从 GitHub 创建" hxGet={routes.pages.projects.new()} hxTarget="#modal-root" hxSwap="innerHTML" />
    </PageHeader>

    {local.length === 0 && remote.length === 0 ? (
      <Empty text="扫描目录下没有发现项目——点右上角「⚙ 扫描目录」检查配置" />
    ) : (
      <div class="flex-1 overflow-auto">
        {local.map((p) => (
          <a
            href={`/canvas?path=${encodeURIComponent(p.path)}`}
            class="group flex h-12 cursor-pointer items-center gap-4 border-b border-harbor-800/60 px-6 hover:bg-harbor-900"
          >
            <span class="text-sm font-medium text-neutral-100 group-hover:text-brass-500">{p.name}</span>
            <span class="mono text-xs text-neutral-600">{p.path}</span>
            {p.hasGit ? (
              <span class="rounded bg-harbor-800 px-1.5 py-0.5 text-[11px] text-neutral-500 mono">git</span>
            ) : null}
            {p.remote ? <span class="mono text-xs text-brass-500/80">⌥ {p.remote}</span> : null}
            <span class="ml-auto flex items-center gap-2">
              {lazygit ? (
                <button
                  class="rounded border border-harbor-700 px-2.5 py-1 text-xs text-neutral-400 transition-colors hover:bg-harbor-800 hover:text-neutral-200"
                  hx-post={routes.pages.projects.open()}
                  hx-vals={`js:{path:${JSON.stringify(p.path)},tool:"lazygit"}`}
                  hx-swap="none"
                  {...{
                    onclick: "event.stopPropagation()",
                    "hx-on::response-error": "alert(event.detail.xhr.responseText)",
                  }}
                >
                  lazygit
                </button>
              ) : null}
              <EditorPicker path={p.path} editors={editors} defaultEditor={defaultEditor} />
              {p.registeredId ? (
                <span {...{ onclick: "event.stopPropagation();event.preventDefault()" }}>
                  <Button
                    label="删除"
                    variant="danger"
                    small
                    hxDelete={routes.pages.projects.ById(p.registeredId)}
                    hxTarget="#main"
                    hxSwap="innerHTML"
                    hxConfirm={`删除项目「${p.name}」及其画布与部署配置？（不会删除本地文件）`}
                  />
                </span>
              ) : null}
            </span>
          </a>
        ))}

        {remote.length > 0 ? (
          <div class="px-6 pt-5 pb-1 text-xs font-medium tracking-wide text-neutral-600">GitHub 项目空间（本地未检出）</div>
        ) : null}
        {remote.map((p) => (
          <a
            href={`/canvas?project=${p.id}`}
            class="group flex h-12 cursor-pointer items-center gap-4 border-b border-harbor-800/60 px-6 hover:bg-harbor-900"
          >
            <span class="text-sm font-medium text-neutral-100 group-hover:text-brass-500">{p.name}</span>
            <span class="mono text-xs text-neutral-600">{p.slug}</span>
            {p.repoUrl ? <span class="mono text-xs text-brass-500/80">⌥ {p.repoUrl}</span> : null}
            <span class="mono ml-auto text-xs text-neutral-600">{p.createdAt.toLocaleDateString("zh-CN")}</span>
            <span {...{ onclick: "event.stopPropagation();event.preventDefault()" }}>
              <Button
                label="删除"
                variant="danger"
                small
                hxDelete={routes.pages.projects.ById(p.id)}
                hxTarget="#main"
                hxSwap="innerHTML"
                hxConfirm={`删除项目「${p.name}」及其画布与部署配置？`}
              />
            </span>
          </a>
        ))}
      </div>
    )}
  </div>
);

// ── 扫描目录配置弹窗：一行一个目录，支持 ~/ ──
export const ConfigModal: Component<{ scanDirs: string[] }> = ({ scanDirs }) => (
  <Modal title="扫描目录" sub="浅扫一级子目录，含 .git 或 package.json 即识别为项目" width="sm">
      <form class="flex flex-col gap-3 px-5 py-4" hx-post={routes.pages.projects.config()} hx-target="#main" hx-swap="innerHTML">
        <textarea
          class="h-28 rounded border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 text-sm text-neutral-200 outline-none mono focus:border-brass-500"
          name="scanDirs"
          spellcheck="false"
        >
          {scanDirs.join("\n")}
        </textarea>
        <p class="mono text-[11px] text-neutral-600">{configFile}</p>
        <button
          type="submit"
          class="inline-flex items-center justify-center rounded bg-brass-500 px-3 py-1.5 text-sm font-semibold text-harbor-950 transition-colors hover:bg-brass-600"
        >
          保存并重新扫描
        </button>
      </form>
  </Modal>
);

// ── 新建项目弹窗：项目 = 仓库，gh CLI 列出账号仓库直接选；也可跳过绑定纯数据库项目 ──
export const NewProjectModal: Component<{ repos: RepoBrief[]; error?: string }> = ({ repos, error }) => (
  <Modal title="新建项目" sub="项目 = 仓库：项目画布就是这个仓库的部署视图" width="md">
      {/* 失败回显走全局 toast（responseError 脚本读服务端 { error } 文本），不再用原生 alert */}
      <form
        class="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4"
        hx-post={routes.pages.projects.index()}
        hx-target="#main"
        hx-swap="innerHTML"
      >
        <input
          id="np-name"
          class="rounded border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 text-sm text-neutral-200 outline-none focus:border-brass-500"
          type="text"
          name="name"
          placeholder="项目名"
          required
          {...{ oninput: "this.dataset.touched='1'" }}
        />
        <input
          class="rounded border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 text-sm text-neutral-200 outline-none focus:border-brass-500"
          type="text"
          placeholder="筛选仓库…"
          {...{ oninput: "const q=this.value.toLowerCase();this.closest('form').querySelectorAll('[data-repo]').forEach(el=>el.classList.toggle('hidden',!el.dataset.repo.includes(q)))" }}
        />
        <div class="min-h-0 flex-1 overflow-y-auto rounded border border-harbor-800">
          <label class="flex cursor-pointer items-center gap-2 border-b border-harbor-800/60 px-3 py-2 text-sm text-neutral-400 hover:bg-harbor-800/60 has-checked:bg-harbor-800">
            <input type="radio" name="repoUrl" value="" checked class="accent-brass-500" />
            跳过，不绑定仓库（纯数据库项目）
          </label>
          {repos.map((r) => (
            <label
              data-repo={r.fullName.toLowerCase()}
              class="flex cursor-pointer items-center gap-2 border-b border-harbor-800/60 px-3 py-2 text-sm text-neutral-200 hover:bg-harbor-800/60 has-checked:bg-harbor-800"
              {...{ onclick: `const n=document.getElementById('np-name');if(!n.dataset.touched)n.value='${r.fullName.split("/")[1]}'` }}
            >
              <input type="radio" name="repoUrl" value={r.fullName} class="accent-brass-500" />
              <span class="mono truncate">{r.fullName}</span>
              {r.private ? <span class="rounded bg-harbor-800 px-1 py-0.5 text-[10px] text-neutral-500">private</span> : null}
              <span class="mono ml-auto shrink-0 text-[11px] text-neutral-600">{r.branch}</span>
            </label>
          ))}
        </div>
        {error ? <p class="text-xs text-brass-500">{error}</p> : null}
        <button
          type="submit"
          class="inline-flex items-center justify-center gap-2 rounded bg-brass-500 px-3 py-1.5 text-sm font-semibold text-harbor-950 transition-colors hover:bg-brass-600 [.htmx-request_&]:pointer-events-none [.htmx-request_&]:opacity-70"
        >
          <span class="htmx-indicator animate-spin">◌</span>
          <span class="[.htmx-request_&]:hidden">创建项目</span>
          <span class="htmx-indicator">创建中…</span>
        </button>
      </form>
  </Modal>
);

// ── GET 片段路由：弹窗内容（挂载在 /api/projects 前缀下） ──
export default defineRoutes()
  // 扫描目录配置弹窗
  .get("/config", async () => <ConfigModal scanDirs={(await loadConfig()).scanDirs} />)
  // 新建项目弹窗：gh CLI 列仓库（未登录时降级为空列表，仍可手填/跳过）
  .get("/new", async ({ di }) => {
    let repos: RepoBrief[] = [];
    let ghError: string | undefined;
    try {
      repos = await di.get("githubService").listRepos();
    } catch (e) {
      ghError = `仓库列表拉取失败（${(e as Error).message}），可跳过绑定`;
    }
    return <NewProjectModal repos={repos} error={ghError} />;
  });
