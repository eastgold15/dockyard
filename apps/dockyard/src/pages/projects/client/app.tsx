/** @jsxImportSource @solidjs/web */
/**
 * 项目列表页（整页 Solid client）：本地扫描（磁盘为准）+ 未检出的 GitHub 项目空间。
 * 行点击进画布（本地按路径、远端按 project id）；编辑器/lazygit 打开走 JSON 端点。
 */
import {
  createSignal,
  For,
  onSettled,
  Show,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import type { LocalProject, NewProjectData, ProjectListModel } from "../projects.types";
import { api, unwrap } from "./api";
import { ConfigModal, NewProjectModal } from "./modals";
import {
  AppShell,
  Badge,
  Button,
  Empty,
  PageHeader,
} from "@/shared/solid-ui/index";
import {
  FeedbackHost,
  confirmAction,
  toast,
} from "@/shared/solid-ui/feedback";
import { button, field } from "../../../../styled-system/recipes";
import { cx } from "../../../../styled-system/css";

/** 编辑器 split-button：主按钮 = 默认编辑器直接开；下拉换一个（服务端会把它记为新默认） */
function EditorPicker(props: {
  path: string;
  editors: string[];
  current: string;
  disabled: boolean;
  onOpen: (tool: string) => void;
}) {
  if (props.editors.length === 0) return null;
  const current = () =>
    props.editors.includes(props.current)
      ? props.current
      : (props.editors[0] ?? "");
  return (
    <span
      class="flex items-center"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        class={cx(
          button({ variant: "ghost", size: "sm" }),
          "rounded-l rounded-r-none",
        )}
        disabled={props.disabled}
        onClick={() => props.onOpen(current())}
      >
        {current()} 打开
      </button>
      <select
        class={cx(
          field(),
          "-ml-px h-8 w-auto rounded-l-none rounded-r px-1 text-xs",
        )}
        value={current()}
        disabled={props.disabled}
        title="选择编辑器（选中即设为默认）"
        onChange={(e) => props.onOpen(e.currentTarget.value)}
      >
        <For each={props.editors}>
          {(e) => <option value={e}>{e}</option>}
        </For>
      </select>
    </span>
  );
}

/** 行的操作区：阻止冒泡，避免触发整行链接 */
function RowActions(props: { children: JSX.Element }) {
  return (
    <span
      class="ml-auto flex shrink-0 items-center gap-2"
      onClick={(e) => e.stopPropagation()}
    >
      {props.children}
    </span>
  );
}

function LocalRow(props: {
  project: LocalProject;
  editors: string[];
  defaultEditor: string;
  lazygit: boolean;
  busy: boolean;
  onOpen: (tool: string) => void;
  onDelete: () => void;
}) {
  return (
    <a
      href={`/canvas?path=${encodeURIComponent(props.project.path)}`}
      class="group flex h-12 cursor-pointer items-center gap-4 border-b border-harbor-800/60 px-4 hover:bg-harbor-900 md:px-6"
    >
      <span
        class="min-w-0 truncate text-sm font-medium text-neutral-100 group-hover:text-brass-500"
        title={props.project.name}
      >
        {props.project.name}
      </span>
      <span
        class="mono min-w-0 truncate text-xs text-neutral-600"
        title={props.project.path}
      >
        {props.project.path}
      </span>
      {props.project.hasGit ? <Badge label="git" /> : null}
      {props.project.remote ? (
        <span
          class="mono min-w-0 max-w-40 truncate text-xs text-brass-500/80"
          title={props.project.remote}
        >
          ⌥ {props.project.remote}
        </span>
      ) : null}
      <RowActions>
        <Show when={props.lazygit}>
          <Button
            label="lazygit"
            variant="ghost"
            size="sm"
            disabled={props.busy}
            onClick={() => props.onOpen("lazygit")}
          />
        </Show>
        <EditorPicker
          path={props.project.path}
          editors={props.editors}
          current={props.defaultEditor}
          disabled={props.busy}
          onOpen={props.onOpen}
        />
        <Show when={props.project.registeredId != null}>
          <Button
            label="删除"
            variant="danger"
            size="sm"
            disabled={props.busy}
            onClick={props.onDelete}
          />
        </Show>
      </RowActions>
    </a>
  );
}

function RemoteRow(props: {
  project: ProjectListModel["remote"][number];
  busy: boolean;
  onDelete: () => void;
}) {
  const created = () =>
    new Date(String(props.project.createdAt)).toLocaleDateString("zh-CN");
  return (
    <a
      href={`/canvas?project=${props.project.id}`}
      class="group flex h-12 cursor-pointer items-center gap-4 border-b border-harbor-800/60 px-4 hover:bg-harbor-900 md:px-6"
    >
      <span
        class="min-w-0 truncate text-sm font-medium text-neutral-100 group-hover:text-brass-500"
        title={props.project.name}
      >
        {props.project.name}
      </span>
      <span
        class="mono min-w-0 truncate text-xs text-neutral-600"
        title={props.project.slug}
      >
        {props.project.slug}
      </span>
      {props.project.repoUrl ? (
        <span
          class="mono min-w-0 max-w-40 truncate text-xs text-brass-500/80"
          title={props.project.repoUrl}
        >
          ⌥ {props.project.repoUrl}
        </span>
      ) : null}
      <RowActions>
        <span class="mono text-xs text-neutral-600">{created()}</span>
        <Button
          label="删除"
          variant="danger"
          size="sm"
          disabled={props.busy}
          onClick={props.onDelete}
        />
      </RowActions>
    </a>
  );
}

export function App() {
  const [model, setModel] = createSignal<ProjectListModel | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [defaultEditor, setDefaultEditor] = createSignal("");
  const [configOpen, setConfigOpen] = createSignal(false);
  const [scanDirs, setScanDirs] = createSignal<string[]>([]);
  const [newOpen, setNewOpen] = createSignal(false);
  const [newData, setNewData] = createSignal<NewProjectData | null>(null);

  const reload = async () => {
    const next = await unwrap(api.get());
    setModel(next);
    setDefaultEditor(next.defaultEditor);
  };

  onSettled(() => {
    void reload()
      .catch((e) => toast((e as Error).message, "err"))
      .finally(() => setLoading(false));
  });

  /** 统一异步动作：同一时间只允许一个，错误进 toast */
  const run = async (fn: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  const open = (path: string, tool: string) =>
    run(async () => {
      await unwrap(api.open.post({ path, tool }));
      if (tool !== "lazygit") setDefaultEditor(tool);
    });

  const remove = async (id: number, name: string) => {
    const ok = await confirmAction({
      title: `删除项目「${name}」及其画布与部署配置？（不会删除本地文件）`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    await run(async () => {
      const next = await unwrap(api({ id }).delete());
      setModel(next);
      setDefaultEditor(next.defaultEditor);
      toast("项目已删除", "ok");
    });
  };

  const openConfig = () =>
    run(async () => {
      const config = await unwrap(api.config.get());
      setScanDirs(config.scanDirs);
      setConfigOpen(true);
    });

  const saveConfig = (text: string) =>
    run(async () => {
      const next = await unwrap(api.config.post({ scanDirs: text }));
      setModel(next);
      setDefaultEditor(next.defaultEditor);
      setConfigOpen(false);
      toast("扫描目录已保存", "ok");
    });

  const openNew = () =>
    run(async () => {
      const data = await unwrap(api.new.get());
      setNewData(data);
      setNewOpen(true);
    });

  const create = (body: { name: string; repoUrl?: string }) =>
    run(async () => {
      const next = await unwrap(api.post(body));
      setModel(next);
      setDefaultEditor(next.defaultEditor);
      setNewOpen(false);
      toast(`项目「${body.name}」已创建`, "ok");
    });

  return (
    <AppShell>
      <div class="flex min-h-0 flex-1 flex-col">
        <PageHeader
          title="项目"
          sub={model() ? `本地 ${model()?.local.length ?? 0} · 远程 ${model()?.remote.length ?? 0}` : undefined}
        >
          <Button
            label="⚙ 扫描目录"
            variant="ghost"
            size="sm"
            onClick={() => void openConfig()}
          />
          <Button
            label="＋ 从 GitHub 创建"
            onClick={() => void openNew()}
          />
        </PageHeader>

        <Show
          when={!loading()}
          fallback={
            <div class="flex flex-1 items-center justify-center text-sm text-neutral-400">
              正在加载项目…
            </div>
          }
        >
          <Show
            when={
              (model()?.local.length ?? 0) + (model()?.remote.length ?? 0) >
              0
            }
            fallback={
              <Empty text="扫描目录下没有发现项目——点右上角「⚙ 扫描目录」检查配置" />
            }
          >
            <div class="flex-1 overflow-auto">
              <For each={model()?.local ?? []}>
                {(project) => (
                  <LocalRow
                    project={project}
                    editors={model()?.editors ?? []}
                    defaultEditor={defaultEditor()}
                    lazygit={model()?.lazygit ?? false}
                    busy={busy()}
                    onOpen={(tool) => void open(project.path, tool)}
                    onDelete={() =>
                      void remove(
                        project.registeredId ?? 0,
                        project.name,
                      )
                    }
                  />
                )}
              </For>

              <Show when={(model()?.remote.length ?? 0) > 0}>
                <div class="px-4 pt-5 pb-1 text-xs font-medium tracking-wide text-neutral-600 md:px-6">
                  GitHub 项目空间（本地未检出）
                </div>
              </Show>
              <For each={model()?.remote ?? []}>
                {(project) => (
                  <RemoteRow
                    project={project}
                    busy={busy()}
                    onDelete={() => void remove(project.id, project.name)}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>

      <Show when={configOpen()}>
        <ConfigModal
          scanDirs={scanDirs()}
          busy={busy()}
          onClose={() => setConfigOpen(false)}
          onSubmit={(text) => void saveConfig(text)}
        />
      </Show>

      <Show when={newOpen() && newData()}>
        {(data) => (
          <NewProjectModal
            data={data()}
            busy={busy()}
            onClose={() => setNewOpen(false)}
            onSubmit={(body) => void create(body)}
          />
        )}
      </Show>

      <FeedbackHost />
    </AppShell>
  );
}
