import { defineRoutes } from "../../../.elysiax";
import { routes } from "../../../.elysiax";
import type { Component } from "@elysiax/htmx";
import type { Project } from "./schema";
import { configFile, loadConfig } from "./config";
import type { RepoBrief } from "../github/github.socket";
import type { LocalProject, LocalService } from "./local.service";
import type { ProjectService } from "./projects.service";
import { Badge, Button, Empty, Modal, PageHeader, cn } from "../../shared/ui";
// Panda recipe：Button/Field/Badge 共享样式只从 recipe 取，不再复制内联主题
import { button, field } from "../../../styled-system/recipes";

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

/**
 * 编辑器 split-button：主按钮 = 默认编辑器直接开；下拉换一个（服务端会把它记为新默认）。
 * 左主按钮与右下拉用 ghost sm + field 紧凑变体，Panda recipe 统一焦点环；
 * `rounded-l`/`rounded-r-none` 等几何由 Tailwind 覆盖（global.css 中 Tailwind 在 Panda 之后）。
 * 打开失败由 elysiax 的 ServiceError JSON 与全局 Toast 统一显示具体错误。
 */
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
        type="button"
        class={cn(button({ variant: "ghost", size: "sm" }), "rounded-l rounded-r-none")}
        hx-post={routes.pages.projects.open()}
        hx-vals={`js:{path:${JSON.stringify(path)},tool:${JSON.stringify(current)}}`}
        hx-swap="none"
      >
        {current} 打开
      </button>
      <select
        class={cn(field(), "-ml-px h-8 w-auto rounded-l-none rounded-r px-1 text-xs")}
        name="tool"
        hx-post={routes.pages.projects.open()}
        hx-trigger="change"
        hx-vals={vals}
        hx-swap="none"
        title="选择编辑器（选中即设为默认）"
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
      {/* 扫描目录为次级配置动作（ghost sm），创建是页面唯一主操作（primary md） */}
      <Button label="⚙ 扫描目录" variant="ghost" small hxGet={routes.pages.projects.config()} hxTarget="#modal-root" hxSwap="innerHTML" />
      <Button label="＋ 从 GitHub 创建" hxGet={routes.pages.projects.new()} hxTarget="#modal-root" hxSwap="innerHTML" />
    </PageHeader>

    {local.length === 0 && remote.length === 0 ? (
      <Empty text="扫描目录下没有发现项目——点右上角「⚙ 扫描目录」检查配置" />
    ) : (
      <div class="flex-1 overflow-auto">
        {local.map((p) => (
          <a
            href={`/canvas?path=${encodeURIComponent(p.path)}`}
            class="group flex h-12 cursor-pointer items-center gap-4 border-b border-harbor-800/60 px-4 hover:bg-harbor-900 md:px-6"
          >
            <span class="min-w-0 truncate text-sm font-medium text-neutral-100 group-hover:text-brass-500" title={p.name}>{p.name}</span>
            <span class="mono min-w-0 truncate text-xs text-neutral-600" title={p.path}>{p.path}</span>
            {p.hasGit ? <Badge label="git" /> : null}
            {p.remote ? <span class="mono min-w-0 max-w-40 truncate text-xs text-brass-500/80" title={p.remote}>⌥ {p.remote}</span> : null}
            <span class="ml-auto flex shrink-0 items-center gap-2">
              {lazygit ? (
                <button
                  type="button"
                  class={button({ variant: "ghost", size: "sm" })}
                  hx-post={routes.pages.projects.open()}
                  hx-vals={`js:{path:${JSON.stringify(p.path)},tool:"lazygit"}`}
                  hx-swap="none"
                  onclick="event.stopPropagation()"
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
          <div class="px-4 pt-5 pb-1 text-xs font-medium tracking-wide text-neutral-600 md:px-6">GitHub 项目空间（本地未检出）</div>
        ) : null}
        {remote.map((p) => (
          <a
            href={`/canvas?project=${p.id}`}
            class="group flex h-12 cursor-pointer items-center gap-4 border-b border-harbor-800/60 px-4 hover:bg-harbor-900 md:px-6"
          >
            <span class="min-w-0 truncate text-sm font-medium text-neutral-100 group-hover:text-brass-500" title={p.name}>{p.name}</span>
            <span class="mono min-w-0 truncate text-xs text-neutral-600" title={p.slug}>{p.slug}</span>
            {p.repoUrl ? <span class="mono min-w-0 max-w-40 truncate text-xs text-brass-500/80" title={p.repoUrl}>⌥ {p.repoUrl}</span> : null}
            <span class="ml-auto flex shrink-0 items-center gap-2">
              <span class="mono text-xs text-neutral-600">{p.createdAt.toLocaleDateString("zh-CN")}</span>
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
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-xs text-neutral-500">扫描目录（每行一个）</span>
          <textarea
            class={cn(field(), "h-28 py-1.5 mono")}
            name="scanDirs"
            spellcheck="false"
          >
            {scanDirs.join("\n")}
          </textarea>
        </label>
        <p class="mono text-[11px] text-neutral-600">{configFile}</p>
        {/* 提交加载态与新建项目弹窗同模式：form 挂 hx-post，请求中 .htmx-request 落在 form 上 */}
        <button
          type="submit"
          class={cn(button({ variant: "primary" }), "gap-2 [.htmx-request_&]:pointer-events-none [.htmx-request_&]:opacity-70")}
        >
          <span class="htmx-indicator animate-spin">◌</span>
          <span class="[.htmx-request_&]:hidden">保存并重新扫描</span>
          <span class="htmx-indicator">保存中…</span>
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
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-xs text-neutral-500">项目名</span>
          <input
            id="np-name"
            class={field()}
            type="text"
            name="name"
            required
            {...{ oninput: "this.dataset.touched='1'" }}
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-xs text-neutral-500">筛选仓库</span>
          <input
            class={field()}
            type="search"
            placeholder="输入仓库名"
            {...{ oninput: "const q=this.value.toLowerCase();this.closest('form').querySelectorAll('[data-repo]').forEach(el=>el.classList.toggle('hidden',!el.dataset.repo.includes(q)))" }}
          />
        </label>
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
              <span class="mono min-w-0 truncate">{r.fullName}</span>
              {r.private ? <Badge label="private" /> : null}
              <span class="mono ml-auto shrink-0 text-[11px] text-neutral-600">{r.branch}</span>
            </label>
          ))}
        </div>
        {error ? <p class="text-xs text-brass-500">{error}</p> : null}
        {/* 提交加载态参考实现：form 挂 hx-post，请求中 .htmx-request 落在 form 上；disabled 类由 recipe 提供 */}
        <button
          type="submit"
          class={cn(button({ variant: "primary" }), "gap-2 [.htmx-request_&]:pointer-events-none [.htmx-request_&]:opacity-70")}
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
