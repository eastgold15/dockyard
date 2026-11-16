/** @jsxImportSource solid-js */
/**
 * 画布抽屉/弹窗（Solid 版）：数据走 /api/canvas JSON，
 * 写操作 JSON 进出，错误内联回显；结构变更后 emitRefresh() 让画布重拉。
 *
 * React → Solid 转换要点：
 * - useState → createSignal，读取一律函数调用（envText() 等）
 * - useEffect → onMount（一次性加载/轮询）/ createEffect（跟随信号重拉）
 * - 行内编辑列表用 <Index> 而非 <For>：patchSvc 换对象引用时 <Index> 保 DOM，输入框不丢焦点
 * - React 版靠 key={repoUrl} 重挂载换 defaultValue，Solid 改为信号量受控输入
 * - onChange → 文本/数字用 onInput，select/checkbox/radio 用 onChange（原生语义）
 */
import {
  createEffect,
  createSignal,
  Index,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  splitProps,
  Switch,
} from "solid-js";
import type { JSX } from "solid-js";
import type {
  Deployment,
  DeploymentRow,
  DeployTarget,
} from "../../../deploy/deploy.socket";
import type { Domain } from "../../../edge/edge.socket";
import type { RepoBrief } from "../../../github/github.socket";
import type { DbConnection, DbRef, EnvEntry } from "../../../deploy/deploy.socket";
import type { DetectResult, DetectedService } from "../../../deploy/deploy.socket";
import type { DiscoveredContainer } from "../../canvas.model";
import copy from "copy-to-clipboard";
// env 文本函数从零依赖模块引（detect.ts 依赖链里的 dotenv 无法进浏览器包）
import { envMapToText, serviceEnvToText, textToEnvMap } from "../../../../shared/env-text";
import { api, deployPaths, unwrap } from "../infra/api";
import { ConsoleView } from "./console";
import { LogView } from "./log-view";
import { emitRefresh, useUi } from "../infra/ui";
import { confirmAction, toast } from "../../../../shared/solid-ui/feedback";
import { useDeployLog, useTargetLive } from "../infra/live";
import {
  mergeLiveRow,
  PipelineSteps,
  stagePosture,
  stepStates,
} from "./pipeline-steps";
// 移除目标的行为与卡面 ✕ 共用一份（成功才关抽屉，取消/失败保持原状）
import { removeTarget } from "../nodes";
// Panda recipe（panda/recipes.ts）：与 htmx 侧共享同一视觉契约，运行时只产 className
import {
  badge,
  button,
  drawer,
  field,
  modal,
} from "../../../../../styled-system/recipes";
import { cx } from "../../../../../styled-system/css";


import { Chip, Drawer, ErrorBanner, Field, Modal, Notice, Section, SubmitBtn } from "./shell";
import type {
  Carry,
  DetectStepData,
  NewAppData,
  SharedMatch,
} from "./new-app-types";
import { AppDetectStep } from "./app-detect";
export function NewAppWizard(props: {
  nodeId: number;
  projectId?: number | null;
}) {
  const ui = useUi();
  const [data, setData] = createSignal<NewAppData | null>(null);
  const [step2, setStep2] = createSignal<DetectStepData | null>(null);
  const [loadError, setLoadError] = createSignal<string>();

  // nodeId 在抽屉生命周期内不变（宿主 keyed 重建），onMount 拉一次即可
  onMount(() => {
    unwrap(
      api["new-app"]({ nodeId: props.nodeId }).get({
        query: props.projectId != null ? { projectId: props.projectId } : {},
      }),
    )
      .then((d) => {
        if (d.mode === "local") setStep2(d);
        else setData(d);
      })
      .catch((e) => setLoadError((e as Error).message));
  });

  const githubData = () => {
    const d = data();
    return d && d.mode === "github" ? d : null;
  };

  return (
    <Switch>
      <Match when={step2()}>
        {(d) => (
          <AppDetectStep
            data={d()}
            onBack={d().carry.repoUrl ? () => setStep2(null) : undefined}
          />
        )}
      </Match>
      <Match when={loadError()}>
        {(err) => (
          <Drawer title="部署 app" onClose={ui.close}>
            <ErrorBanner>{err()}</ErrorBanner>
          </Drawer>
        )}
      </Match>
      <Match when={githubData()}>
        {(d) => (
          <NewAppStep1
            nodeId={props.nodeId}
            projectId={props.projectId}
            repos={d().repos}
            reposStale={d().reposStale}
            prefillRepo={d().prefillRepo}
            onDetected={setStep2}
          />
        )}
      </Match>
      <Match when={true}>
        <Drawer title="部署 app" onClose={ui.close}>
          <div class="text-xs text-neutral-500">加载中…</div>
        </Drawer>
      </Match>
    </Switch>
  );
}

function NewAppStep1(props: {
  nodeId: number;
  projectId?: number | null;
  repos: RepoBrief[];
  reposStale?: boolean;
  prefillRepo?: string;
  onDetected: (d: DetectStepData) => void;
}) {
  const ui = useUi();
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [repoUrl, setRepoUrl] = createSignal(props.prefillRepo ?? "");
  // 仓库列表：本地信号（首次无缓存时后台刷新落盘，之后复用）
  const [repos, setRepos] = createSignal<RepoBrief[]>(props.repos);
  const [refreshing, setRefreshing] = createSignal(false);
  // 名称/远端目录跟随仓库名预填但可手改（React 版靠 key={repoUrl} 重挂载换 defaultValue，
  // Solid 无 key 语义，改为信号量受控）
  const [name, setName] = createSignal(props.prefillRepo?.split("/")[1] ?? "");
  const [remoteDir, setRemoteDir] = createSignal(
    props.prefillRepo?.split("/")[1]
      ? `~/dockyard/${props.prefillRepo.split("/")[1]}`
      : "",
  );

  /** 手动/首次后台刷新仓库列表（持久缓存：拉一次，之后用缓存，除非这里再点） */
  const refreshRepos = async () => {
    setRefreshing(true);
    try {
      const { repos: fresh } = await unwrap(api.repos.refresh.post());
      setRepos(fresh);
    } catch (err) {
      setError(`仓库列表刷新失败：${(err as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  };

  // 首次打开无缓存：后台拉一次（不阻塞抽屉渲染），之后走缓存
  onMount(() => {
    if (props.reposStale) void refreshRepos();
  });

  const pickRepo = (v: string) => {
    setRepoUrl(v);
    const n = v.split("/")[1] ?? "";
    setName(n);
    setRemoteDir(n ? `~/dockyard/${n}` : "");
  };

  const submit = async (
    e: SubmitEvent & { currentTarget: HTMLFormElement },
  ) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const d = await unwrap(
        api.detect.post({
          nodeId: props.nodeId,
          // 透镜归属必须原样带回（服务端 carry: body），否则 step2 只能按 repoUrl 反查项目
          projectId: props.projectId ?? undefined,
          name: name(),
          repoUrl: repoUrl(),
          branch: String(fd.get("branch") ?? "main") || "main",
          remoteDir: remoteDir(),
        }),
      );
      props.onDetected(d);
    } catch (err) {
      setError(`识别失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title="部署 app"
      sub="从 GitHub 仓库部署到这台服务器"
      onClose={ui.close}
    >
      <form class="flex flex-col gap-4" onSubmit={submit}>
        {error() ? <ErrorBanner>{error()}</ErrorBanner> : null}
        <Section
          title="仓库"
          hint={
            repos().length
              ? `gh 账号下 ${repos().length} 个（缓存）`
              : "无缓存：点「刷新仓库列表」或手动输入 owner/repo"
          }
        >
          <div class="flex items-end gap-2">
            <label class="flex flex-1 flex-col gap-1 text-sm">
              <span class="text-xs text-neutral-500">
                选择仓库（可输入过滤）
              </span>
              <input
                class={field()}
                type="text"
                name="repoUrl"
                list="gh-repos"
                placeholder="owner/repo"
                autocomplete="off"
                value={repoUrl()}
                onInput={(e) => pickRepo(e.currentTarget.value)}
                required
              />
            </label>
            <button
              type="button"
              class={button({ variant: "ghost", size: "md" })}
              disabled={refreshing()}
              onClick={() => void refreshRepos()}
            >
              {refreshing() ? "刷新中…" : "刷新仓库列表"}
            </button>
          </div>
          <datalist id="gh-repos">
            <For each={repos()}>
              {(r) => (
                <option
                  value={r.fullName}
                >{`${r.private ? "🔒" : "🌐"} ${r.branch}`}</option>
              )}
            </For>
          </datalist>
        </Section>
        <Section title="基本">
          <div class="grid grid-cols-2 gap-2">
            <Field
              label="名称"
              name="name"
              placeholder="my-app"
              required
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
            <Field label="分支" name="branch" value="main" />
          </div>
          <Field
            label="远端目录"
            name="remoteDir"
            placeholder="~/dockyard/my-app"
            required
            value={remoteDir()}
            onInput={(e) => setRemoteDir(e.currentTarget.value)}
          />
        </Section>
        <div class="text-xs text-neutral-500">
          下一步会读取仓库的 dockyard.json / compose 自动识别服务、端口与域名。
        </div>
        <SubmitBtn
          label="下一步：识别仓库"
          busyLabel="识别中…（调 GitHub API，通常几秒）"
          busy={busy()}
        />
      </form>
    </Drawer>
  );
}


