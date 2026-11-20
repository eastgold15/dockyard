/** @jsxImportSource @solidjs/web */
/**
 * projects 页的两个弹窗：扫描目录配置 / 新建项目（从 GitHub 仓库选或跳过）。
 * 弹层行为走 Kobalte（经 shared Modal），外观走 Panda recipe；提交错误由父层 toast 回显。
 */
import {
  createSignal,
  For,
} from "solid-js";
import type { NewProjectData, RepoBrief } from "../projects.types";
import { field } from "../../../../styled-system/recipes";
import { cx } from "../../../../styled-system/css";
import {
  Badge,
  Button,
  Field,
  Modal,
  TextInput,
} from "@/shared/solid-ui/index";

/** 扫描目录配置：一行一个目录，支持 ~/ */
export function ConfigModal(props: {
  scanDirs: string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (scanDirs: string) => void;
}) {
  const [text, setText] = createSignal(props.scanDirs.join("\n"));
  return (
    <Modal
      open
      title="扫描目录"
      sub="浅扫一级子目录，含 .git 或 package.json 即识别为项目"
      width="sm"
      onClose={props.onClose}
    >
      <form
        class="flex flex-col gap-3 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          props.onSubmit(text());
        }}
      >
        <Field label="扫描目录（每行一个）">
          <textarea
            class={cx(field(), "mono h-28 py-1.5")}
            spellcheck="false"
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
          />
        </Field>
        <Button
          type="submit"
          label={props.busy ? "保存中…" : "保存并重新扫描"}
          disabled={props.busy}
        />
      </form>
    </Modal>
  );
}

/** 新建项目：项目 = 仓库，gh CLI 列出账号仓库直接选；也可跳过绑定做纯数据库项目 */
export function NewProjectModal(props: {
  data: NewProjectData;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { name: string; repoUrl?: string }) => void;
}) {
  const [query, setQuery] = createSignal("");
  const [name, setName] = createSignal("");
  const [touched, setTouched] = createSignal(false);
  const [selected, setSelected] = createSignal("");

  const filtered = (): RepoBrief[] => {
    const q = query().trim().toLowerCase();
    if (!q) return props.data.repos;
    return props.data.repos.filter((r) => r.fullName.toLowerCase().includes(q));
  };

  const selectRepo = (repo: RepoBrief | null) => {
    setSelected(repo ? repo.fullName : "");
    if (repo && !touched()) setName(repo.fullName.split("/")[1] ?? "");
  };

  return (
    <Modal
      open
      title="新建项目"
      sub="项目 = 仓库：项目画布就是这个仓库的部署视图"
      width="md"
      onClose={props.onClose}
    >
      <form
        class="flex min-h-0 flex-1 flex-col gap-3 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          props.onSubmit({ name: name().trim(), repoUrl: selected() || undefined });
        }}
      >
        <TextInput
          label="项目名"
          value={name()}
          required
          onInput={(e) => {
            setTouched(true);
            setName(e.currentTarget.value);
          }}
        />
        <TextInput
          label="筛选仓库"
          type="search"
          placeholder="输入仓库名"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <div class="min-h-0 flex-1 overflow-y-auto rounded border border-harbor-800">
          <label class="flex cursor-pointer items-center gap-2 border-b border-harbor-800/60 px-3 py-2 text-sm text-neutral-400 hover:bg-harbor-800/60">
            <input
              type="radio"
              name="repo"
              checked={selected() === ""}
              class="accent-brass-500"
              onChange={() => selectRepo(null)}
            />
            跳过，不绑定仓库（纯数据库项目）
          </label>
          <For each={filtered()}>
            {(repo) => (
              <label class="flex cursor-pointer items-center gap-2 border-b border-harbor-800/60 px-3 py-2 text-sm text-neutral-200 hover:bg-harbor-800/60">
                <input
                  type="radio"
                  name="repo"
                  checked={selected() === repo.fullName}
                  class="accent-brass-500"
                  onChange={() => selectRepo(repo)}
                />
                <span class="mono min-w-0 truncate">{repo.fullName}</span>
                {repo.private ? <Badge label="private" /> : null}
                <span class="mono ml-auto shrink-0 text-[11px] text-neutral-600">
                  {repo.branch}
                </span>
              </label>
            )}
          </For>
        </div>
        {props.data.error ? (
          <p class="text-xs text-brass-500">{props.data.error}</p>
        ) : null}
        <Button
          type="submit"
          label={props.busy ? "创建中…" : "创建项目"}
          disabled={props.busy}
        />
      </form>
    </Modal>
  );
}
