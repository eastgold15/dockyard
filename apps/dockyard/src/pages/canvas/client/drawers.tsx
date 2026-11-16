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
} from "../../deploy/deploy.socket";
import type { Domain } from "../../edge/edge.socket";
import type { RepoBrief } from "../../github/github.socket";
import type { DbConnection, DbRef, EnvEntry } from "../../deploy/deploy.socket";
import type { DetectResult, DetectedService } from "../../deploy/deploy.socket";
import type { DiscoveredContainer } from "../canvas.model";
import copy from "copy-to-clipboard";
// env 文本函数从零依赖模块引（detect.ts 依赖链里的 dotenv 无法进浏览器包）
import { envMapToText, serviceEnvToText, textToEnvMap } from "../../../shared/env-text";
import { api, deployPaths, unwrap } from "./api";
import { ConsoleView } from "./console";
import { LogView } from "./log-view";
import { emitRefresh, useUi } from "./ui";
import { confirmAction, toast } from "./feedback";
import { useDeployLog, useTargetLive } from "./live";
import {
  mergeLiveRow,
  PipelineSteps,
  stagePosture,
  stepStates,
} from "./pipeline-steps";
// 移除目标的行为与卡面 ✕ 共用一份（成功才关抽屉，取消/失败保持原状）
import { removeTarget } from "./nodes";
// Panda recipe（panda/recipes.ts）：与 htmx 侧共享同一视觉契约，运行时只产 className
import {
  badge,
  button,
  drawer,
  field,
  modal,
} from "../../../../styled-system/recipes";
import { cx } from "../../../../styled-system/css";

// ── 壳与通用件 ──

/**
 * 遮罩点击关闭的状态机（Modal/Drawer 共用，别各写一份）：
 * 只有「同一根指针按下与松开都落在遮罩上」才关。click 的 target 是公共祖先，
 * 两个方向都会误判——面板内拖选文本拖到遮罩松手、或按住遮罩拖进面板松手。
 * 按 pointerId 记录按下位置：多指时互不覆盖；pointercancel 复位（手势被系统夺走不算点击）。
 *
 * 注：这是手写弹层（CLAUDE.md 倾向 Kobalte Dialog）。迁移会同时带来 Esc/焦点陷阱/aria，
 * 但涉及全部抽屉的视觉与交互验证，留作独立改动，不混在正确性修复里。
 */
function overlayClose(onClose: () => void) {
  const downOn = new Map<number, boolean>(); // pointerId → 按下时是否在遮罩
  let lastUpOnOverlay = false;
  return {
    onPointerDown(e: PointerEvent) {
      downOn.set(e.pointerId, e.target === e.currentTarget);
    },
    onPointerUp(e: PointerEvent) {
      lastUpOnOverlay =
        downOn.get(e.pointerId) === true && e.target === e.currentTarget;
      downOn.delete(e.pointerId);
    },
    onPointerCancel(e: PointerEvent) {
      downOn.delete(e.pointerId);
      lastUpOnOverlay = false;
    },
    onClick(e: MouseEvent) {
      if (!lastUpOnOverlay || e.target !== e.currentTarget) return;
      lastUpOnOverlay = false; // 一次按下只消费一次
      onClose();
    },
  };
}

export const Modal = (props: {
  title: string;
  wide?: boolean;
  children: JSX.Element;
  onClose: () => void;
}) => {
  const m = () => modal({ width: props.wide ? "lg" : "sm" });
  return (
    <div
      data-shell="overlay"
      class={m().overlay}
      {...overlayClose(() => props.onClose())}
    >
      <div data-shell="panel" class={m().panel}>
        <div class={m().header}>
          <h3 class={m().title}>{props.title}</h3>
          <button class={m().close} onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div class={cx(m().body, "p-5")}>{props.children}</div>
      </div>
    </div>
  );
};

/** 右侧抽屉（Railway 式配置面板）：默认 576px、宽 768px，窄屏全宽（maxWidth 100% 兜底） */
export const Drawer = (props: {
  title: string;
  sub?: string;
  wide?: boolean;
  children: JSX.Element;
  onClose: () => void;
}) => {
  const d = () => drawer({ width: props.wide ? "lg" : "md" });
  return (
    <div
      data-shell="overlay"
      class={d().overlay}
      {...overlayClose(() => props.onClose())}
    >
      <div data-shell="panel" class={d().panel}>
        <div class={d().header}>
          <div class="flex flex-col gap-1">
            <h3 class={d().title}>{props.title}</h3>
            {props.sub ? <p class={d().sub}>{props.sub}</p> : null}
          </div>
          <button class={d().close} onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div class={d().body}>{props.children}</div>
      </div>
    </div>
  );
};

const Section = (props: {
  title: string;
  hint?: string;
  class?: string;
  children: JSX.Element;
}) => (
  <section class={`flex flex-col gap-2 ${props.class ?? ""}`}>
    <div class="flex items-baseline justify-between">
      <h4 class="text-xs font-semibold tracking-wide text-neutral-300 uppercase">
        {props.title}
      </h4>
      {props.hint ? (
        <span class="text-[11px] text-neutral-600">{props.hint}</span>
      ) : null}
    </div>
    {props.children}
  </section>
);

const ErrorBanner = (props: { children: JSX.Element }) => (
  <div class="rounded bg-signal-500/15 px-3 py-2 text-xs text-signal-500">
    {props.children}
  </div>
);

const Notice = (props: { children: JSX.Element }) => (
  <div class="rounded bg-tide-400/10 px-3 py-2 text-xs text-tide-400">
    {props.children}
  </div>
);

const Chip = (props: {
  tone?: "ok" | "warn" | "err" | "muted";
  children: JSX.Element;
}) => (
  <span class={badge({ tone: props.tone ?? "muted" })}>{props.children}</span>
);

const Field = (
  props: { label: string } & JSX.InputHTMLAttributes<HTMLInputElement>,
) => {
  const [local, rest] = splitProps(props, ["label"]);
  return (
    <label class="flex flex-col gap-1 text-sm">
      <span class="text-xs text-neutral-500">{local.label}</span>
      <input class={field()} {...rest} />
    </label>
  );
};

/** 提交按钮（busy 状态：识别要调 gh API / 部署要克隆，必须给用户即时反馈） */
const SubmitBtn = (props: {
  label: string;
  busyLabel: string;
  busy: boolean;
}) => (
  <button
    type="submit"
    disabled={props.busy}
    class={cx(button({ variant: "primary", size: "md" }), "gap-2")}
  >
    {props.busy ? <span class="animate-spin">◌</span> : null}
    {props.busy ? props.busyLabel : props.label}
  </button>
);

// ── 共享类型（与 canvas.actions 的 JSON 响应对齐）──

interface Carry {
  nodeId: number;
  projectId?: number | null;
  name: string;
  repoUrl?: string;
  branch: string;
  remoteDir: string;
}
interface SharedMatch {
  service: string;
  name: string;
  dbType: string;
  envKey: string;
  url: string;
  displayUrl: string;
}
interface DetectStepData {
  carry: Carry;
  detect: DetectResult;
  envText: string;
  dbRefs: DbRef[];
  sharedMatches: SharedMatch[];
}
type NewAppData =
  | {
      mode: "github";
      repos: RepoBrief[];
      reposStale?: boolean;
      prefillRepo?: string;
    }
  | ({ mode: "local" } & DetectStepData);

// ── 部署 app 向导（Railway/openship 两步式，右侧抽屉）──

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

/** 服务行编辑状态（step2 受控） */
interface SvcEdit {
  name: string;
  exposed: boolean;
  port?: number;
  domain?: string;
  cpuCores?: number;
  memoryMb?: number;
  envText: string;
}

const svcEditOf = (s: DetectedService): SvcEdit => ({
  name: s.name,
  exposed: s.exposed,
  port: s.port,
  domain: s.domain,
  cpuCores: s.cpuCores,
  memoryMb: s.memoryMb,
  envText: serviceEnvToText(s.env),
});

const numOrUndef = (v: string) => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : undefined;
};

/** 构建方式分类（镜像名/服务名启发式，与 detect.guessDbType 同口径）：db → 拉取镜像，app → 构建镜像 */
const DB_SERVICE_RE =
  /postgres|pgvector|postgis|mysql|mariadb|redis|valkey|dragonfly|mongo/;
const isDbService = (s: { name: string; image?: string }) =>
  DB_SERVICE_RE.test(`${s.image ?? ""} ${s.name}`.toLowerCase());

/** Step 2：识别结果确认。errors 硬阻断，warnings 只提示 */
function AppDetectStep(props: { data: DetectStepData; onBack?: () => void }) {
  const ui = useUi();
  const { carry, detect, dbRefs, sharedMatches } = props.data;
  const [error, setError] = createSignal<string>();
  const [services, setServices] = createSignal<SvcEdit[]>(
    detect.services.map(svcEditOf),
  );
  const [envText, setEnvText] = createSignal(props.data.envText);
  const [composePath, setComposePath] = createSignal(detect.composePath);
  const [depIds, setDepIds] = createSignal<number[]>([]);
  const [reuse, setReuse] = createSignal<ReadonlySet<string>>(
    new Set(sharedMatches.map((m) => m.service)),
  );
  // Railway 式：清单按顺序逐个部署，每个服务独立 target/构建/日志（不一次建多服务卡）
  const [deployed, setDeployed] = createSignal<ReadonlySet<string>>(new Set());
  const [deployingSvc, setDeployingSvc] = createSignal<string>();

  /** envText 行的声明式增删（替代旧 onchange 行内脚本） */
  const syncEnvLine = (line: string, on: boolean) => {
    const lines = envText()
      .split("\n")
      .filter((l) => l.trim() && l !== line);
    if (on) lines.push(line);
    setEnvText(lines.join("\n"));
  };

  const patchSvc = (name: string, patch: Partial<SvcEdit>) =>
    setServices((cur) =>
      cur.map((s) => (s.name === name ? { ...s, ...patch } : s)),
    );

  /** 单个服务的创建 + 立即部署（db 服务由后端判定无 build → pull，app → build） */
  const deployOne = async (svc: SvcEdit) => {
    setDeployingSvc(svc.name);
    setError(undefined);
    try {
      const { targetId } = await unwrap(
        api.targets.app.post({
          nodeId: carry.nodeId,
          projectId: carry.projectId ?? undefined,
          name: svc.name,
          repoUrl: carry.repoUrl || undefined,
          branch: carry.branch,
          composePath: composePath(),
          serviceName: svc.name,
          autoDeploy: true,
          remoteDir: carry.remoteDir,
          envText: envText(),
          services: [
            {
              name: svc.name,
              exposed: svc.exposed,
              port: svc.exposed ? svc.port : undefined,
              domain: svc.domain || undefined,
              cpuCores: svc.cpuCores,
              memoryMb: svc.memoryMb,
              env: textToEnvMap(svc.envText),
            },
          ],
          depIds: depIds(),
          reuse: [...reuse()].filter((r) => r === svc.name),
        }),
      );
      emitRefresh();
      setDeployed((cur) => new Set([...cur, svc.name]));
      ui.open({ kind: "log", targetId });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeployingSvc(undefined);
    }
  };

  /** 未识别到服务（无 dockyard.json/compose 在根目录）时的兜底：按 compose 全量构建（旧行为） */
  const deployWhole = async () => {
    setDeployingSvc("__whole__");
    setError(undefined);
    try {
      const { targetId } = await unwrap(
        api.targets.app.post({
          nodeId: carry.nodeId,
          projectId: carry.projectId ?? undefined,
          name: carry.name,
          repoUrl: carry.repoUrl || undefined,
          branch: carry.branch,
          composePath: composePath(),
          autoDeploy: true,
          remoteDir: carry.remoteDir,
          envText: envText(),
          services: [],
          depIds: depIds(),
          reuse: [],
        }),
      );
      emitRefresh();
      ui.open({ kind: "log", targetId });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeployingSvc(undefined);
    }
  };

  return (
    <Drawer
      title={carry.name}
      sub={
        carry.repoUrl ? `${carry.repoUrl}@${carry.branch}` : "本地文件夹导入"
      }
      onClose={ui.close}
    >
      <div class="flex flex-col gap-5">
        <div class="flex items-center gap-2 text-xs text-neutral-400">
          识别来源
          {detect.source === "dockyard.json" ? (
            <Chip tone="ok">dockyard.json</Chip>
          ) : detect.source === "compose" ? (
            <Chip tone="warn">compose 探测</Chip>
          ) : (
            <Chip tone="warn">未识别</Chip>
          )}
        </div>

        {error() ? <ErrorBanner>{error()}</ErrorBanner> : null}
        <For each={detect.errors}>
          {(er) => <ErrorBanner>{er}</ErrorBanner>}
        </For>
        <Show when={detect.warnings.length > 0}>
          <div class="rounded bg-brass-500/10 px-3 py-2 text-xs text-brass-500">
            <For each={detect.warnings}>{(w) => <div>⚠️ {w}</div>}</For>
          </div>
        </Show>

        <Show when={services().length > 0}>
          <Section
            title="服务"
            hint={`${services().length} 个 · 端口/域名/资源`}
          >
            {/* Index 按位置渲染：patchSvc 换对象引用时保 DOM，输入不丢焦点 */}
            <Index each={services()}>
              {(svc) => (
                <div class="rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2.5">
                  <div class="mb-2 flex items-center gap-2">
                    <span class="text-xs font-medium text-neutral-200 mono">
                      {svc().name}
                    </span>
                    <Chip tone={isDbService(svc()) ? "muted" : "ok"}>
                      {isDbService(svc()) ? "拉取镜像" : "构建镜像"}
                    </Chip>
                    {svc().exposed ? (
                      <Chip tone="ok">对外</Chip>
                    ) : (
                      <Chip>内部</Chip>
                    )}
                    <Show when={svc().cpuCores || svc().memoryMb}>
                      <Chip tone="warn">
                        {[
                          svc().cpuCores ? `${svc().cpuCores}C` : "",
                          svc().memoryMb ? `${svc().memoryMb}M` : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      </Chip>
                    </Show>
                  </div>
                  <div class="grid grid-cols-4 gap-2">
                    <label class="flex flex-col gap-0.5">
                      <span class="text-xs text-neutral-500">
                        <input
                          type="checkbox"
                          checked={svc().exposed}
                          class="mr-1 accent-brass-500"
                          onChange={(e) =>
                            patchSvc(svc().name, {
                              exposed: e.currentTarget.checked,
                            })
                          }
                        />
                        对外端口
                      </span>
                      <input
                        class={field()}
                        type="number"
                        placeholder="内部"
                        value={svc().port ?? ""}
                        disabled={!svc().exposed}
                        onInput={(e) =>
                          patchSvc(svc().name, {
                            port: numOrUndef(e.currentTarget.value),
                          })
                        }
                      />
                    </label>
                    <label class="col-span-3 flex flex-col gap-0.5">
                      <span class="text-xs text-neutral-500">
                        绑定域名（留空 = 不绑，需先勾对外）
                      </span>
                      <input
                        class={field()}
                        type="text"
                        placeholder="api.example.com"
                        value={svc().domain ?? ""}
                        onInput={(e) =>
                          patchSvc(svc().name, {
                            domain: e.currentTarget.value,
                          })
                        }
                      />
                    </label>
                    <label class="col-span-2 flex flex-col gap-0.5">
                      <span class="text-xs text-neutral-500">
                        CPU 上限（核）
                      </span>
                      <input
                        class={field()}
                        type="number"
                        step="0.1"
                        placeholder="不限"
                        value={svc().cpuCores ?? ""}
                        onInput={(e) =>
                          patchSvc(svc().name, {
                            cpuCores: numOrUndef(e.currentTarget.value),
                          })
                        }
                      />
                    </label>
                    <label class="col-span-2 flex flex-col gap-0.5">
                      <span class="text-xs text-neutral-500">
                        内存上限（MB）
                      </span>
                      <input
                        class={field()}
                        type="number"
                        placeholder="不限"
                        value={svc().memoryMb ?? ""}
                        onInput={(e) =>
                          patchSvc(svc().name, {
                            memoryMb: numOrUndef(e.currentTarget.value),
                          })
                        }
                      />
                    </label>
                  </div>
                  <Show when={svc().envText.trim()}>
                    <details class="mt-2">
                      <summary class="cursor-pointer text-[11px] text-neutral-500 select-none">
                        环境变量 · 随 override 注入容器
                      </summary>
                      <textarea
                        class={cx(
                          field(),
                          "mono mt-1 min-h-28 py-1.5 text-[11px] leading-relaxed",
                        )}
                        value={svc().envText}
                        onInput={(e) =>
                          patchSvc(svc().name, {
                            envText: e.currentTarget.value,
                          })
                        }
                      />
                    </details>
                  </Show>
                </div>
              )}
            </Index>
          </Section>
        </Show>

        <Show when={sharedMatches.length > 0}>
          <Section
            title="复用服务器资源？"
            hint="前置检查：服务器已有匹配的共享中间件"
          >
            <div class="flex flex-col gap-1.5">
              <For each={sharedMatches}>
                {(m) => (
                  <label class="flex cursor-pointer items-center gap-2 rounded border border-tide-400/30 bg-tide-400/5 px-3 py-2 text-xs text-neutral-300 transition-colors has-checked:border-tide-400/70">
                    <input
                      type="checkbox"
                      checked={reuse().has(m.service)}
                      class="accent-tide-400"
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        const next = new Set(reuse());
                        if (on) next.add(m.service);
                        else next.delete(m.service);
                        setReuse(next);
                        syncEnvLine(`${m.envKey}=${m.url}`, on);
                      }}
                    />
                    <span class="flex min-w-0 flex-col">
                      <span>
                        服务{" "}
                        <span class="mono text-neutral-200">{m.service}</span>{" "}
                        复用共享资源「{m.name}」（{m.dbType}）→{" "}
                        <span class="mono text-tide-400">{m.envKey}</span>
                      </span>
                      <span class="mono truncate text-[10px] text-neutral-600">
                        {m.displayUrl}
                      </span>
                    </span>
                  </label>
                )}
              </For>
              <div class="text-[11px] text-neutral-600">
                勾选 = 跳过该中间件部署，自动注入共享连接串；取消 =
                随项目完整部署。
              </div>
            </div>
          </Section>
        </Show>

        <Show when={dbRefs.length > 0}>
          <Section title="依赖数据库" hint="画布连线 + 注入连接串">
            <DbRefPicker
              refs={dbRefs}
              selected={depIds()}
              onToggle={(r, on) => {
                setDepIds((cur) =>
                  on ? [...cur, r.id] : cur.filter((id) => id !== r.id),
                );
                syncEnvLine(`${r.envKey}=${r.url}`, on);
              }}
            />
          </Section>
        </Show>

        <Section title="变量" hint="compose 插值用 · 加密保存">
          <textarea
            class={cx(field(), "mono min-h-28 py-2 text-xs leading-relaxed")}
            placeholder="KEY=value"
            value={envText()}
            onInput={(e) => setEnvText(e.currentTarget.value)}
          />
        </Section>

        <Section title="构建" hint="构建目录 + compose 文件路径">
          <label class="flex flex-col gap-1 text-sm">
            <span class="text-xs text-neutral-500">
              构建目录 / compose 文件路径（monorepo 可写子目录）
            </span>
            <input
              class={field()}
              type="text"
              value={composePath()}
              required
              placeholder="docker-compose.yml 或 apps/web/docker-compose.yml"
              onInput={(e) => setComposePath(e.currentTarget.value)}
            />
          </label>
        </Section>

        <Show
          when={services().length > 0}
          fallback={
            <Section
              title="部署"
              hint="未识别到服务，将按 compose 全量构建部署"
            >
              <button
                type="button"
                class={button({ variant: "primary", size: "md" })}
                disabled={Boolean(deployingSvc())}
                onClick={() => void deployWhole()}
              >
                {deployingSvc() ? "部署中…" : "创建并部署"}
              </button>
            </Section>
          }
        >
          <Section
            title="部署"
            hint="按清单顺序逐个部署：数据库拉取镜像、应用构建镜像"
          >
            <div class="flex flex-col gap-1.5">
              <Index each={services()}>
                {(svc) => (
                  <div class="flex items-center gap-2 rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2">
                    <span class="mono text-xs text-neutral-200">
                      {svc().name}
                    </span>
                    <Chip tone={isDbService(svc()) ? "muted" : "ok"}>
                      {isDbService(svc()) ? "拉取镜像" : "构建镜像"}
                    </Chip>
                    <span class="flex-1" />
                    <Show
                      when={deployed().has(svc().name)}
                      fallback={
                        <button
                          type="button"
                          class={button({ variant: "primary", size: "sm" })}
                          disabled={Boolean(deployingSvc())}
                          onClick={() => void deployOne(svc())}
                        >
                          {deployingSvc() === svc().name ? "部署中…" : "部署"}
                        </button>
                      }
                    >
                      <Chip tone="ok">已部署</Chip>
                    </Show>
                  </div>
                )}
              </Index>
            </div>
            <div class="text-[11px] text-neutral-600">
              每个服务独立建卡、独立构建、独立日志；上一个完成后再部署下一个。
            </div>
          </Section>
        </Show>

        <div class="flex gap-2 border-t border-harbor-800 pt-4">
          <Show when={props.onBack}>
            <button
              type="button"
              class={button({ variant: "ghost", size: "md" })}
              onClick={props.onBack}
            >
              上一步
            </button>
          </Show>
        </div>
      </div>
    </Drawer>
  );
}

/** 数据库依赖选择器：勾选 = 记录血缘（画布连线）+ 把连接串注入 envText */
const DbRefPicker = (props: {
  refs: DbRef[];
  selected: number[];
  onToggle: (r: DbRef, on: boolean) => void;
}) => (
  <div class="flex flex-col gap-1.5">
    <For each={props.refs}>
      {(r) => (
        <label class="flex cursor-pointer items-center gap-2 rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2 text-xs text-neutral-300 transition-colors has-checked:border-brass-500/60 has-checked:bg-brass-500/5">
          <input
            type="checkbox"
            checked={props.selected.includes(r.id)}
            class="accent-brass-500"
            onChange={(e) => props.onToggle(r, e.currentTarget.checked)}
          />
          <span class="shrink-0 text-neutral-200">
            {r.logical ? "⛁" : "🗄"} {r.name}
          </span>
          <span class="flex min-w-0 flex-col">
            <span class="text-neutral-600">
              {r.dbType}
              {r.logical ? " · 逻辑库" : ""} →{" "}
              <span class="mono text-tide-400">{r.envKey}</span>
            </span>
            <span class="mono truncate text-[10px] text-neutral-700">
              {r.displayUrl}
            </span>
          </span>
        </label>
      )}
    </For>
    <div class="text-[11px] text-neutral-600">
      勾选即注入连接串到下方变量；取消即移除。多个同类型数据库请自行改变量名。
    </div>
  </div>
);

// ── 新建数据库 ──

type DbType = "postgres" | "mysql" | "redis" | "mongo";

export function NewDbModal(props: {
  nodeId: number;
  projectId?: number | null;
}) {
  const ui = useUi();
  const [dbType, setDbType] = createSignal<DbType>("postgres");
  const [instances, setInstances] = createSignal<DeployTarget[]>([]);
  const [instanceId, setInstanceId] = createSignal("");
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);

  // 跟随 dbType 重拉同类型实例（等价 React 的 [nodeId, dbType] 依赖）。
  // 请求世代：快速切 postgres→mysql→redis 时，慢的旧响应不能把新类型的列表顶掉，
  // 否则界面显示 mysql 实例、实际按 redis 建库。项目归属一起传给服务端过滤——
  // 选了别的项目的实例，新建的逻辑库会跟随宿主项目，在当前透镜里立即消失。
  let instGen = 0;
  createEffect(() => {
    const t = dbType();
    const my = ++instGen;
    setInstanceId("");
    unwrap(
      api.instances.get({
        query: {
          nodeId: props.nodeId,
          dbType: t,
          projectId: props.projectId ?? undefined,
        },
      }),
    )
      .then((d) => {
        if (my === instGen) setInstances(d.instances);
      })
      .catch(() => {
        if (my === instGen) setInstances([]);
      });
  });

  const submit = async (
    e: SubmitEvent & { currentTarget: HTMLFormElement },
  ) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      await unwrap(
        api.targets.db.post({
          nodeId: props.nodeId,
          // 透镜归属：缺了它，新建实例 projectId=null，applyLens 过滤后卡在当前透镜里立即消失
          projectId: props.projectId ?? undefined,
          name: String(fd.get("name") ?? ""),
          dbType: dbType(),
          instanceId: instanceId() || undefined,
          remoteDir: String(fd.get("remoteDir") ?? "") || undefined,
        }),
      );
      emitRefresh();
      ui.close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="部署数据库（官方镜像）" onClose={ui.close}>
      <form class="flex flex-col gap-3" onSubmit={submit}>
        <Field label="名称" name="name" placeholder="my_pg" required />
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-xs text-neutral-500">类型</span>
          <select
            class={field()}
            value={dbType()}
            onChange={(e) => setDbType(e.currentTarget.value as DbType)}
          >
            <option value="postgres">PostgreSQL</option>
            <option value="mysql">MySQL</option>
            <option value="redis">Redis</option>
            <option value="mongo">MongoDB</option>
          </select>
        </label>
        <div class="flex flex-col gap-1.5 text-sm">
          <label class="flex items-center gap-2 text-neutral-300">
            <input
              type="radio"
              name="instanceId"
              value=""
              checked={instanceId() === ""}
              onChange={() => setInstanceId("")}
            />{" "}
            新建实例
          </label>
          <For each={instances()}>
            {(i) => (
              <label class="flex items-center gap-2 text-neutral-300">
                <input
                  type="radio"
                  name="instanceId"
                  value={String(i.id)}
                  checked={instanceId() === String(i.id)}
                  onChange={() => setInstanceId(String(i.id))}
                />
                在「{i.name}」中新建逻辑库（省一个容器的开销）
              </label>
            )}
          </For>
          <Show when={instances().length > 0}>
            <div class="text-xs text-neutral-500">
              选现有实例时无需填远端目录，凭据自动生成。
            </div>
          </Show>
        </div>
        <Field
          label="远端目录"
          name="remoteDir"
          placeholder="~/dockyard/my_pg（新建实例时必填）"
        />
        {error() ? <ErrorBanner>{error()}</ErrorBanner> : null}
        <div class="text-xs text-neutral-500">
          凭据自动生成并加密保存，数据卷持久化。
        </div>
        <SubmitBtn label="创建并部署" busyLabel="创建中…" busy={busy()} />
      </form>
    </Modal>
  );
}

// ── 域名管理 ──

const dnsChip = (d: Domain) =>
  d.dnsStatus === "ok" ? (
    <Chip tone="ok">DNS ✓</Chip>
  ) : d.dnsStatus === "mismatch" ? (
    <Chip tone="warn">DNS 未指向本机</Chip>
  ) : (
    <Chip>DNS 未检测</Chip>
  );
const sslChip = (d: Domain) =>
  d.sslStatus === "active" ? (
    <Chip tone="ok">🔒 HTTPS</Chip>
  ) : d.sslStatus === "pending" ? (
    <Chip tone="warn">证书待签发</Chip>
  ) : d.sslStatus === "error" ? (
    <Chip tone="err">证书异常</Chip>
  ) : (
    <Chip>无证书</Chip>
  );

interface DomainsData {
  target: DeployTarget;
  domains: Domain[];
}

export function DomainsModal(props: { targetId: number }) {
  const ui = useUi();
  const [data, setData] = createSignal<DomainsData | null>(null);
  const [error, setError] = createSignal<string>();

  const load = () => {
    unwrap(api.targets({ id: props.targetId }).domains.get())
      .then(setData)
      .catch((e) => setError((e as Error).message));
  };
  onMount(load);

  const remove = async (d: Domain) => {
    if (
      !(await confirmAction({
        title: `解绑 ${d.hostname}？`,
        confirmLabel: "解绑",
        danger: true,
      }))
    )
      return;
    try {
      await unwrap(api.domains({ id: d.id }).delete());
      emitRefresh();
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const submit = async (
    e: SubmitEvent & { currentTarget: HTMLFormElement },
  ) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(undefined);
    try {
      await unwrap(
        api.targets({ id: props.targetId }).domains.post({
          hostname: String(fd.get("hostname") ?? ""),
          targetPort: Number(fd.get("targetPort")),
        }),
      );
      e.currentTarget.reset();
      emitRefresh();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title={`域名 — ${data()?.target.name ?? "…"}`} onClose={ui.close}>
      <div class="flex flex-col gap-3">
        {error() ? <ErrorBanner>{error()}</ErrorBanner> : null}
        <Show when={data() && data()!.domains.length === 0}>
          <div class="text-xs text-neutral-500">
            还没有绑定域名。绑定后自动反代并签发 HTTPS 证书。
          </div>
        </Show>
        <For each={data()?.domains ?? []}>
          {(d) => (
            <div class="flex items-center justify-between gap-2 rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2">
              <div class="flex flex-col gap-1">
                <a
                  class="text-xs font-medium text-tide-400 hover:opacity-80 mono"
                  href={`https://${d.hostname}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {d.hostname}
                </a>
                <span class="text-[11px] text-neutral-500 mono">
                  → :{d.targetPort}
                  {d.serviceName ? `（${d.serviceName}）` : ""}
                </span>
              </div>
              <div class="flex items-center gap-1.5">
                {dnsChip(d)}
                {sslChip(d)}
                <button
                  class={button({ variant: "danger", size: "sm" })}
                  onClick={() => void remove(d)}
                >
                  ✕
                </button>
              </div>
            </div>
          )}
        </For>
        <form class="flex items-end gap-2" onSubmit={submit}>
          <label class="flex flex-1 flex-col gap-0.5">
            <span class="text-xs text-neutral-500">域名</span>
            <input
              class={field()}
              type="text"
              name="hostname"
              placeholder="app.example.com"
              required
            />
          </label>
          <label class="flex w-24 flex-col gap-0.5">
            <span class="text-xs text-neutral-500">端口</span>
            <input class={field()} type="number" name="targetPort" required />
          </label>
          <button
            type="submit"
            class={button({ variant: "primary", size: "md" })}
          >
            绑定
          </button>
        </form>
        <div class="text-xs text-neutral-500">
          域名 A 记录指向服务器 IP 后，证书会自动签发。
        </div>
      </div>
    </Modal>
  );
}

// ── 变量抽屉（已有 app 改 .env + 数据库依赖）──

interface EnvData {
  target: DeployTarget;
  envText: string;
  entries: EnvEntry[];
  dbRefs: DbRef[];
  selectedDeps: number[];
  connection: DbConnection | null;
  /** app 里自带的数据库服务可能有多条（托管实例只有一条） */
  connections: DbConnection[];
}

/** 敏感键名默认打码：变量页会被截图/共享，密码不应直接铺在屏幕上 */
const SECRET_KEY_RE = /(PASS|SECRET|TOKEN|CREDENTIAL|PRIVATE)/i;

const copyText = async (text: string, label: string) => {
  if (await copy(text)) toast(`${label}已复制`, "ok");
};

/** .env 文本 → 行列表（注释/空行不保留：结构化编辑的代价，保存时也按行重建） */
const envRowsFromText = (text: string): EnvEntry[] =>
  Object.entries(textToEnvMap(text)).map(([key, v]) => ({
    key,
    value: v.value,
  }));

/** 行列表 → .env 文本（走共享零依赖序列化，引号规则与部署端一致） */
const envRowsToText = (rows: EnvEntry[]): string =>
  envMapToText(
    Object.fromEntries(
      rows
        .filter((r) => r.key.trim())
        .map((r) => [r.key.trim(), { value: r.value, secret: false }]),
    ),
  );

/** 勾选数据库 = 写入连接串行（同 key 覆盖；多个同类型库自行改变量名） */
const upsertEnvRow = (
  rows: EnvEntry[],
  key: string,
  value: string,
): EnvEntry[] => {
  const hit = rows.findIndex((r) => r.key === key);
  return hit >= 0
    ? rows.map((r, i) => (i === hit ? { ...r, value } : r))
    : [...rows, { key, value }];
};

const removeEnvRowsByValue = (rows: EnvEntry[], value: string): EnvEntry[] =>
  rows.filter((r) => r.value !== value);

/** 可编辑变量表：key/value 行 + 增删 + 敏感值显示切换（受控输入，Index 保 DOM 不丢焦点） */
function EnvRowsEditor(props: {
  rows: EnvEntry[];
  onChange: (rows: EnvEntry[]) => void;
  disabled?: boolean;
}) {
  const [revealed, setRevealed] = createSignal<Record<number, boolean>>({});
  const patch = (idx: number, patch: Partial<EnvEntry>) =>
    props.onChange(
      props.rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
  return (
    <div class="flex flex-col gap-2">
      <Index each={props.rows}>
        {(row, i) => (
          <div class="flex items-start gap-1.5">
            <input
              class={cx(field(), "mono w-36 shrink-0 text-xs")}
              placeholder="KEY"
              disabled={props.disabled}
              value={row().key}
              onInput={(e) => patch(i, { key: e.currentTarget.value })}
            />
            <div class="flex min-w-0 flex-1 items-center gap-1.5">
              <input
                class={cx(field(), "mono min-w-0 flex-1 text-xs")}
                type={
                  SECRET_KEY_RE.test(row().key) && !revealed()[i]
                    ? "password"
                    : "text"
                }
                placeholder="value"
                disabled={props.disabled}
                value={row().value}
                onInput={(e) => patch(i, { value: e.currentTarget.value })}
              />
              <Show when={SECRET_KEY_RE.test(row().key)}>
                <button
                  type="button"
                  class={button({ variant: "ghost", size: "sm" })}
                  onClick={() =>
                    setRevealed((cur) => ({ ...cur, [i]: !cur[i] }))
                  }
                >
                  {revealed()[i] ? "隐藏" : "显示"}
                </button>
              </Show>
              <Show when={!props.disabled}>
                <button
                  type="button"
                  class={button({ variant: "danger", size: "sm" })}
                  aria-label={`删除变量 ${row().key || "未命名"}`}
                  onClick={() =>
                    props.onChange(props.rows.filter((_, idx) => idx !== i))
                  }
                >
                  ✕
                </button>
              </Show>
            </div>
          </div>
        )}
      </Index>
      <Show when={!props.disabled}>
        <button
          type="button"
          class={cx(button({ variant: "ghost", size: "sm" }), "self-start")}
          onClick={() => props.onChange([...props.rows, { key: "", value: "" }])}
        >
          ＋ 添加变量
        </button>
      </Show>
    </div>
  );
}

/** 数据库连接信息：容器内网 + 外网（已绑定域名优先），密码段默认打码。
 *  service 有值 = 用户 compose 自带的库（docker 网络内用服务名解析）。 */
function DbConnectionSection(props: { conn: DbConnection }) {
  const [revealed, setRevealed] = createSignal(false);
  const envKey = () =>
    props.conn.dbType === "redis" ? "REDIS_URL" : "DATABASE_URL";
  const masked = (url: string) =>
    revealed()
      ? url
      : url.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/]*@/, "$1•••@");
  const Row = (p: { label: string; value: string }) => (
    <div class="flex items-center gap-2 rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2">
      <span class="w-16 shrink-0 text-xs text-neutral-500">{p.label}</span>
      <span class="mono min-w-0 flex-1 truncate text-xs text-neutral-200">
        {masked(p.value)}
      </span>
      <button
        type="button"
        class={button({ variant: "ghost", size: "sm" })}
        onClick={() => void copyText(p.value, p.label)}
      >
        复制
      </button>
    </div>
  );
  return (
    <Section
      title={props.conn.service ? `连接信息 · ${props.conn.service}` : "连接信息"}
      hint={props.conn.deployed ? "已部署" : "部署成功后可用"}
    >
      <div class="flex flex-col gap-1.5">
        <Row label="容器内网" value={props.conn.internalUrl} />
        <Show
          when={props.conn.externalUrl}
          fallback={
            <p class="text-[11px] text-neutral-600">
              未发布宿主端口：只能在同一个 compose
              网络的容器内访问（应用变量名建议 {envKey()}）。
            </p>
          }
        >
          <Row label="外网 URL" value={props.conn.externalUrl!} />
        </Show>
        <div class="flex items-center justify-between gap-2 text-[11px] text-neutral-600">
          <span>
            {props.conn.user ?? "—"} · {props.conn.database ?? "—"} ·
            :{props.conn.port} · 变量名 {envKey()}
          </span>
          <button
            type="button"
            class={button({ variant: "ghost", size: "sm" })}
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed() ? "隐藏密码" : "显示密码"}
          </button>
        </div>
        <p class="text-[11px] text-neutral-600">
          {props.conn.domain
            ? `外网走已绑定域名 ${props.conn.domain}`
            : props.conn.service && !props.conn.published
              ? "内网地址可在同一 compose 项目的其他服务里直接引用"
              : "未绑定域名：外网使用服务器地址"}
          {props.conn.logical ? "；逻辑库在宿主实例内" : ""}
        </p>
      </div>
    </Section>
  );
}

export function EnvDrawer(props: { targetId: number }) {
  const ui = useUi();
  const [data, setData] = createSignal<EnvData | null>(null);
  const [rows, setRows] = createSignal<EnvEntry[]>([]);
  const [depIds, setDepIds] = createSignal<number[]>([]);
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    unwrap(api.targets({ id: props.targetId }).env.get())
      .then((d) => {
        setData(d);
        setRows(d.entries);
        setDepIds(d.selectedDeps);
      })
      .catch((e) => setError((e as Error).message));
  });

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await unwrap(
        api
          .targets({ id: props.targetId })
          .env.post({ entries: rows(), depIds: depIds() }),
      );
      emitRefresh();
      ui.close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title={`变量 — ${data()?.target.name ?? "…"}`}
      sub="保存后重新部署生效"
      onClose={ui.close}
    >
      <form class="flex flex-col gap-5" onSubmit={submit}>
        {error() ? <ErrorBanner>{error()}</ErrorBanner> : null}
        <For each={data()?.connections ?? []}>
          {(conn) => <DbConnectionSection conn={conn} />}
        </For>
        <Show when={data() && data()!.dbRefs.length > 0}>
          <Section title="依赖数据库" hint="勾选 = 画布连线 + 注入连接串">
            <DbRefPicker
              refs={data()!.dbRefs}
              selected={depIds()}
              onToggle={(r, on) => {
                setDepIds((cur) =>
                  on ? [...cur, r.id] : cur.filter((id) => id !== r.id),
                );
                setRows((cur) =>
                  on
                    ? upsertEnvRow(cur, r.envKey, r.url)
                    : removeEnvRowsByValue(cur, r.url),
                );
              }}
            />
          </Section>
        </Show>
        <Section title="变量" hint="compose 插值用 · 加密保存">
          <Show
            when={data()?.target.kind !== "db" || !data()!.connection?.logical}
            fallback={
              <p class="text-xs text-neutral-500">
                逻辑库的变量由宿主实例生成，不可编辑。
              </p>
            }
          >
            <EnvRowsEditor rows={rows()} onChange={setRows} />
          </Show>
        </Section>
        <SubmitBtn label="保存变量" busyLabel="保存中…" busy={busy()} />
      </form>
    </Drawer>
  );
}

// ── 部署日志（HTTP 回填 + SSE 增量，终态最后一次 HTTP 对齐防丢行）──

// 与服务端返回对齐：dep 缺部署记录时是 undefined（Eden 推断的真实形状）
interface LogData {
  target: DeployTarget;
  dep?: Deployment | null;
}

export function DeployLogModal(props: { targetId: number; dep?: number }) {
  const ui = useUi();
  const [data, setData] = createSignal<LogData | null>(null);
  const [backfill, setBackfill] = createSignal("尚未部署");
  /** 终态对齐后的权威全文（SSE 增量可能因重连/行数上限丢行，终态以 HTTP 为准） */
  const [finalText, setFinalText] = createSignal<string | null>(null);
  const live = useTargetLive(props.targetId);
  const liveLog = useDeployLog(props.targetId);

  const fetchBody = async () => {
    // 日志体是裸文本流（非 JSON），走原生 fetch + 路径助手
    const res = await fetch(
      `${deployPaths.targetsByIdLogBody(props.targetId)}${props.dep ? `?dep=${props.dep}` : ""}`,
    );
    return res.text();
  };

  onMount(async () => {
    try {
      const d = await unwrap(
        api
          .targets({ id: props.targetId })
          .log.get({ query: { dep: props.dep } }),
      );
      setData(d);
      const text = await fetchBody();
      setBackfill(text || "尚未部署");
    } catch {
      setBackfill("加载失败");
    }
  });

  // 终态对齐：live 状态进入 success/failed 时做最后一次 HTTP 全量回填。
  // 必须确认终态属于本抽屉看的那次 run：看历史日志时，别的 run 收尾不该触发回填
  createEffect(() => {
    const s = live().status;
    const depId = data()?.dep?.id;
    if (
      !depId ||
      finalText() !== null ||
      live().runId !== depId ||
      (s !== "success" && s !== "failed")
    )
      return;
    void (async () => {
      try {
        const head = await unwrap(
          api
            .targets({ id: props.targetId })
            .log.get({ query: { dep: props.dep } }),
        );
        setData(head);
        setFinalText((await fetchBody()) || "尚未部署");
      } catch {
        /* 对齐失败则维持 SSE/backfill 显示 */
      }
    })();
  });

  // 显示优先级：终态全文 > 当前 run 的 SSE 实时行 > 初始回填
  const logText = () => {
    const fin = finalText();
    if (fin !== null) return fin;
    const dep = data()?.dep;
    const lg = liveLog();
    if (dep && lg && lg.runId === dep.id && lg.lines.length)
      return lg.lines.join("\n");
    return backfill();
  };

  // 实时状态只在「属于正在看的那次 run」时才算数：看历史 run 的日志时，
  // 当前新 run 的 building 不能冒充成它的状态（服务端 status 帧带 runId）
  const depStatus = () => {
    const l = live();
    const depId = data()?.dep?.id;
    if (depId != null && l.runId !== depId) return data()?.dep?.status;
    return l.status ?? data()?.dep?.status;
  };
  return (
    <Modal
      title={`部署日志 — ${data()?.target.name ?? "…"}`}
      wide
      onClose={ui.close}
    >
      <Show when={depStatus()}>
        {(s) => (
          <div class="mb-2">
            <Chip
              tone={
                s() === "success" ? "ok" : s() === "failed" ? "err" : "muted"
              }
            >
              {s()}
            </Chip>
          </div>
        )}
      </Show>
      <LogView text={logText()} height="24rem" />
    </Modal>
  );
}

// ── 服务抽屉（Railway Service View）──

type ServiceTab =
  "deployments" | "variables" | "metrics" | "console" | "settings" | "backups";

interface Metrics {
  state: string;
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  netRx: number;
  netTx: number;
}

interface ServiceDrawerData {
  target: DeployTarget;
  /** 服务端判定的构建来源形态（与部署分派同口径；null 兼容旧响应） */
  sourceType?: "local" | "github";
  svc?: string;
  /** 后端回显的 tab（全量返回后仅作回显，前端不依赖其裁剪数据） */
  tab?: string;
  deployments?: DeploymentRow[];
  envText?: string;
  dbRefs?: DbRef[];
  /** 该服务是用户 compose 自带的数据库时，服务端给出的连接信息 */
  connections?: DbConnection[];
  sharedEnv?: {
    resourceId: number;
    name: string;
    dbType: string;
    envKey: string;
    url: string;
  }[];
  selectedDeps?: number[];
  domains?: Domain[];
  resources?: { cpuCores?: number; memoryMb?: number };
  backups?: { file: string; size: number; at: string | Date }[];
  /** 该实例能否自动恢复（服务端按引擎能力判定；false = 只能下载后手动执行） */
  backupRestorable?: boolean;
  metrics?: Metrics | null;
}

const fmtBytes = (n: number) =>
  n >= 1 << 30
    ? `${(n / (1 << 30)).toFixed(1)} GB`
    : n >= 1 << 20
      ? `${(n / (1 << 20)).toFixed(1)} MB`
      : `${(n / 1024).toFixed(0)} KB`;

const fmtAgo = (d: Date | string) => {
  const s = Math.max(
    1,
    Math.round((Date.now() - new Date(d).getTime()) / 1000),
  );
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.round(s / 60)}m 前`;
  if (s < 86400) return `${Math.round(s / 3600)}h 前`;
  return new Date(d).toLocaleDateString("zh-CN");
};

/** 一次性资源快照（4s 轮询） */
const MetricsPanel = (props: { targetId: number; svc?: string }) => {
  const [stats, setStats] = createSignal<Metrics | null | undefined>(undefined);
  onMount(() => {
    const tick = async () => {
      try {
        const m = await unwrap(
          api
            .targets({ id: props.targetId })
            .service.metrics.get({ query: { svc: props.svc } }),
        );
        setStats(m);
      } catch {
        setStats(null);
      }
    };
    void tick();
    const timer = setInterval(tick, 4000);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <Switch>
      <Match when={stats() === undefined}>
        <div class="rounded bg-harbor-950 px-3 py-2 text-xs text-neutral-500">
          加载中…
        </div>
      </Match>
      <Match when={stats() === null}>
        <div class="rounded bg-harbor-950 px-3 py-2 text-xs text-neutral-500">
          指标不可用（容器未运行或服务器离线）
        </div>
      </Match>
      <Match when={stats()!.state !== "running" ? stats() : null}>
        {(m) => (
          <div class="rounded bg-harbor-950 px-3 py-2 text-xs text-neutral-500">
            容器状态:{m()!.state}
          </div>
        )}
      </Match>
      <Match when={stats()}>
        {(m) => (
          <div class="flex flex-col gap-3">
            <For
              each={[
                {
                  label: "CPU",
                  pct: Math.min(100, m()!.cpuPercent),
                  text: `${m()!.cpuPercent}%`,
                },
                {
                  label: "内存",
                  pct: m()!.memLimit
                    ? Math.min(100, (m()!.memUsage / m()!.memLimit) * 100)
                    : 0,
                  text: `${fmtBytes(m()!.memUsage)} / ${fmtBytes(m()!.memLimit)}`,
                },
              ]}
            >
              {(row) => (
                <div class="flex flex-col gap-1">
                  <div class="flex justify-between text-xs text-neutral-400">
                    <span>{row.label}</span>
                    <span class="mono">{row.text}</span>
                  </div>
                  <div class="h-1.5 overflow-hidden rounded bg-harbor-800">
                    <div
                      class={`h-full rounded ${row.pct > 85 ? "bg-signal-500" : "bg-tide-400"}`}
                      style={{ width: `${row.pct.toFixed(1)}%` }}
                    />
                  </div>
                </div>
              )}
            </For>
            <div class="flex justify-between text-xs text-neutral-400">
              <span>网络</span>
              <span class="mono">
                ↓ {fmtBytes(m()!.netRx)} · ↑ {fmtBytes(m()!.netTx)}
              </span>
            </div>
          </div>
        )}
      </Match>
    </Switch>
  );
};

/** 服务日志（2s 轮询） */
const ServiceLogs = (props: { targetId: number; svc?: string }) => {
  const [text, setText] = createSignal("加载中…");
  onMount(() => {
    // SSH 拉 docker logs 可能超过一个轮询周期：禁止请求重叠，且只接受最后一次
    // 发出的请求结果，否则先发后到的旧快照会把新日志顶回去（表现为日志回跳/重复）
    let seq = 0;
    let inflight = false;
    const tick = async () => {
      if (inflight) return;
      inflight = true;
      const my = ++seq;
      try {
        const res = await fetch(
          `${deployPaths.targetsByIdServiceLogs(props.targetId)}${props.svc ? `?svc=${encodeURIComponent(props.svc)}` : ""}`,
        );
        if (!res.ok) {
          if (my === seq) setText(`日志获取失败：HTTP ${res.status}`);
          return;
        }
        const next = await res.text();
        if (my === seq) setText(next);
      } catch {
        /* 下轮再说 */
      } finally {
        inflight = false;
      }
    };
    void tick();
    const timer = setInterval(tick, 2000);
    onCleanup(() => clearInterval(timer));
  });
  // 撑满抽屉里除操作行/历史列表外的剩余高度：不再用固定 40vh 把日志裁在抽屉底边外
  return <LogView text={text()} fill />;
};

export function ServiceDrawer(props: {
  targetId: number;
  svc?: string;
  initialTab?: string;
}) {
  const ui = useUi();
  const [tab, setTab] = createSignal<ServiceTab>(
    ([
      "deployments",
      "variables",
      "metrics",
      "console",
      "settings",
      "backups",
    ].includes(props.initialTab ?? "")
      ? props.initialTab
      : "deployments") as ServiceTab,
  );
  const [data, setData] = createSignal<ServiceDrawerData | null>(null);
  const [notice, setNotice] = createSignal<string>();
  const [error, setError] = createSignal<string>();

  // 请求世代：同一 tab 的 mount 与 SSE reload 也会并发，后到的旧快照不能顶掉新数据
  let gen = 0;
  const load = async () => {
    const my = ++gen;
    try {
      // 后端已改为全量返回（tab 只作回显，不再裁剪数据），前端一律传自身 tab 即可。
      const d = await unwrap(
        api
          .targets({ id: props.targetId })
          .service.get({ query: { tab: tab(), svc: props.svc } }),
      );
      // 世代守卫：切 tab / SSE 触发的并发 reload 里，只有最近一次请求的结果能写入
      if (my !== gen) return;
      setData(d);
    } catch (e) {
      // 世代守卫同样覆盖失败路径：切 tab 后旧请求的失败不能写进新 tab 的错误横幅
      if (my !== gen) return;
      setError((e as Error).message);
    }
  };
  // 跟随 tab 重拉（等价 React 的 [load] 依赖）；首挂也跑一次
  createEffect(() => {
    tab();
    setNotice(undefined);
    setError(undefined);
    void load();
  });

  /** 写操作统一出口：成功后提示 + 按需刷新画布/抽屉数据 */
  const mutate = async (
    fn: () => Promise<{ notice?: string }>,
    opts: { refreshBoard?: boolean; reload?: boolean } = {},
  ) => {
    setError(undefined);
    setNotice(undefined);
    try {
      const r = await fn();
      if (r.notice) setNotice(r.notice);
      if (opts.refreshBoard) emitRefresh();
      if (opts.reload !== false) await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const target = () => data()?.target;
  const isDbInstance = () => target()?.kind === "db" && !target()?.instanceOf;
  // Railway 式导航：Deployments / Variables / Metrics / Console / Settings（backups 仅 db）
  const tabs = (): { key: ServiceTab; label: string }[] => [
    { key: "deployments", label: "Deployments" },
    { key: "variables", label: "Variables" },
    { key: "metrics", label: "Metrics" },
    { key: "console", label: "Console" },
    { key: "settings", label: "Settings" },
    ...(isDbInstance() ? [{ key: "backups" as const, label: "Backups" }] : []),
  ];

  return (
    <Drawer
      wide
      title={
        props.svc
          ? `${target()?.name ?? "…"} / ${props.svc}`
          : (target()?.name ?? "…")
      }
      sub={props.svc ? "服务" : target()?.kind === "db" ? "数据库" : "应用"}
      onClose={ui.close}
    >
      {/* Deployments 页签用整高 flex：运行时日志吃满剩余空间；其他页签保持自然高度可滚动 */}
      <div
        class={cx(
          "flex flex-col gap-4",
          tab() === "deployments" ? "h-full min-h-0" : undefined,
        )}
      >
        <div class="flex gap-1 border-b border-harbor-800 pb-2">
          <For each={tabs()}>
            {(tb) => (
              <button
                onClick={() => setTab(tb.key)}
                class={`rounded px-2.5 py-1 text-xs transition-colors ${tab() === tb.key ? "bg-brass-500/15 font-medium text-brass-500" : "text-neutral-400 hover:bg-harbor-800 hover:text-neutral-200"}`}
              >
                {tb.label}
              </button>
            )}
          </For>
        </div>

        {notice() ? <Notice>{notice()}</Notice> : null}
        {error() ? <ErrorBanner>{error()}</ErrorBanner> : null}
        {!data() ? <div class="text-xs text-neutral-500">加载中…</div> : null}

        <Show when={data()}>
          {(d) => (
            <>
              <Show when={tab() === "deployments"}>
                <DeploymentsTab
                  data={d()}
                  svc={props.svc}
                  mutate={mutate}
                  reload={load}
                />
                <Section
                  title="运行时日志"
                  hint="实时流"
                  class="min-h-0 flex-1"
                >
                  <ServiceLogs targetId={props.targetId} svc={props.svc} />
                </Section>
              </Show>
              <Show when={tab() === "variables"}>
                {props.svc ? (
                  <ServiceEnvTab data={d()} svc={props.svc} mutate={mutate} />
                ) : (
                  <TargetEnvTab data={d()} mutate={mutate} />
                )}
              </Show>
              <Show when={tab() === "metrics"}>
                <MetricsPanel targetId={props.targetId} svc={props.svc} />
              </Show>
              <Show when={tab() === "console"}>
                <div class="flex flex-col gap-2">
                  <p class="text-xs text-neutral-500">
                    进入{props.svc ? `服务 ${props.svc}` : "容器"}
                    的交互式终端（docker exec）。关闭抽屉即断开。
                  </p>
                  <div class="h-[55vh] overflow-hidden rounded border border-harbor-800 bg-harbor-950 p-1">
                    <ConsoleView
                      targetId={props.targetId}
                      service={props.svc}
                    />
                  </div>
                </div>
              </Show>
              <Show when={tab() === "settings"}>
                <div class="flex flex-col gap-5">
                  <SourceTab data={d()} svc={props.svc} mutate={mutate} />
                  <Show when={props.svc}>
                    <HardwareTab data={d()} svc={props.svc!} mutate={mutate} />
                  </Show>
                  <NetworkTab data={d()} svc={props.svc} mutate={mutate} />
                  <Section title="危险区域">
                    <button
                      class={button({ variant: "danger", size: "sm" })}
                      onClick={() => {
                        void removeTarget(target()!).then((removed) => {
                          if (removed) ui.close();
                        });
                      }}
                    >
                      移除部署目标
                    </button>
                  </Section>
                </div>
              </Show>
              <Show when={tab() === "backups" && isDbInstance()}>
                <BackupsTab data={d()} mutate={mutate} />
              </Show>
            </>
          )}
        </Show>
      </div>
    </Drawer>
  );
}

type Mutate = (
  fn: () => Promise<{ notice?: string }>,
  opts?: { refreshBoard?: boolean; reload?: boolean },
) => Promise<void>;

function DeploymentsTab(props: {
  data: ServiceDrawerData;
  svc?: string;
  mutate: Mutate;
  reload: () => Promise<void>;
}) {
  const ui = useUi();
  const t = () => props.data.target;
  // 实时通道：进行中 run 的步骤条跟 SSE 脉冲，历史行回落到库值
  const live = useTargetLive(t().id);
  // 列表对齐的两个时机（effect 只依赖 live，reload 不回写 live，不会自激）：
  // 1) runId 换主 = 新 run 开播：库里还没有这一行，不拉列表步骤条就没有宿主行；
  // 2) 终态：SSE 只带粗状态，库里的 stage/rollbackable/finishedAt 需要对齐。
  // 用 runId 而不是 running 判「新 run」——running 在整段执行中都为 true，
  // 拿它当条件会变成每次 status 迁移都重拉一次列表。
  let seenRunId: number | null = null;
  let prevStatus: string | null = null;
  createEffect(() => {
    const s = live().status;
    const id = live().runId;
    if (id != null && id !== seenRunId) {
      seenRunId = id;
      prevStatus = s;
      void props.reload();
      return;
    }
    const terminal = s === "success" || s === "failed";
    const wasTerminal = prevStatus === "success" || prevStatus === "failed";
    prevStatus = s;
    // 只认「非终态 → 终态」这一跳：终态之后服务端还会推一条 running:false，
    // store 对象换新会让 effect 再跑一次，按值判断会把同一次收尾重拉两遍
    if (terminal && !wasTerminal) void props.reload();
  });
  return (
    <>
      <div class="flex shrink-0 items-center gap-2">
        <button
          class={button({ variant: "primary", size: "sm" })}
          onClick={async () => {
            await unwrap(api.targets({ id: t().id }).deploy.post());
            // 部署是后台任务：先拉一次让 queued 行出现在列表，后续段位由 SSE 驱动
            await props.reload();
            ui.open({ kind: "log", targetId: t().id });
          }}
        >
          重新部署
        </button>
        <button
          class={button({ variant: "ghost", size: "sm" })}
          onClick={() =>
            void props.mutate(
              () =>
                unwrap(
                  api
                    .targets({ id: t().id })
                    .service.restart.post({ svc: props.svc }),
                ),
              { reload: false },
            )
          }
        >
          重启{props.svc ? "服务" : "容器"}
        </button>
        {/* 本地导入 app 的显式通道：构建产物推到远端（跨区移动的门票），不起容器。
            判据用服务端给的 sourceType：local 项目也可能带 repoUrl（克隆到本地后导入），
            按「没有 repoUrl」判会把这类 app 的传输按钮藏掉，跨区移动彻底死锁 */}
        <Show when={t().kind === "app" && props.data.sourceType === "local"}>
          <button
            class={button({ variant: "ghost", size: "sm" })}
            title={
              t().artifactShipped
                ? "产物已传输过（可再传更新）"
                : "跨区移动前必须先传输产物"
            }
            onClick={async () => {
              await unwrap(api.targets({ id: t().id }).ship.post());
              await props.reload();
              ui.open({ kind: "log", targetId: t().id });
            }}
          >
            传输产物{t().artifactShipped ? " ✓" : ""}
          </button>
        </Show>
        {/* 部署策略三态：manual 不轮询 / notify 只亮徽章 / auto 检出更新即部署 */}
        <select
          class={cx(field(), "ml-auto h-8 w-auto text-xs")}
          value={t().deployPolicy}
          title="检出更新时：手动部署=不轮询；仅提醒=亮「有更新」徽章；自动部署=立即触发"
          onChange={(e) =>
            void props.mutate(
              () =>
                unwrap(
                  api
                    .targets({ id: t().id })
                    .policy.post({
                      policy: e.currentTarget.value as
                        "manual" | "notify" | "auto",
                    }),
                ),
              { reload: false },
            )
          }
        >
          <option value="manual">手动部署</option>
          <option value="notify">仅提醒</option>
          <option value="auto">自动部署</option>
        </select>
      </div>
      {/* 历史列表自带上限与滚动：不让长历史把下面的运行时日志顶出抽屉可视区 */}
      <div class="flex max-h-64 shrink-0 flex-col overflow-y-auto">
        <Show when={(props.data.deployments ?? []).length === 0}>
          <div class="py-4 text-center text-xs text-neutral-600">
            还没有部署记录
          </div>
        </Show>
        <For each={props.data.deployments ?? []}>
          {(d) => {
            // 只有「在跑的那一行」吃实时值：历史行若也读 live，会显示成当前 run 的状态/段位
            const run = () => mergeLiveRow(d, live());
            const runStatus = () => run().status;
            const runStage = () => run().stage;
            return (
              <div class="flex items-center gap-3 border-b border-harbor-800/60 py-2 text-xs">
                <Chip
                  tone={
                    runStatus() === "success"
                      ? "ok"
                      : runStatus() === "failed"
                        ? "err"
                        : "muted"
                  }
                >
                  {runStatus()}
                </Chip>
                <span class="text-neutral-500">#{d.id}</span>
                {/* 触发来源：手动/自动/回滚/仅传输（回滚带血缘号） */}
                <Show when={d.trigger && d.trigger !== "ui"}>
                  <span class="rounded border border-harbor-700 px-1 text-[10px] text-neutral-500">
                    {d.trigger === "rollback"
                      ? `回滚←#${d.rollbackOf}`
                      : d.trigger === "ship"
                        ? "仅传输"
                        : "自动"}
                  </span>
                </Show>
                {/* 六阶段迷你步骤条：stage=null（旁路/存量）降级不显示。
                  用合并后的 runStage 判降级——新 run 的库行 stage 还是 null，实时值已到 */}
                <Show
                  when={stagePosture(
                    { ...t(), sourceType: props.data.sourceType },
                    { trigger: d.trigger, stage: runStage() },
                  )}
                >
                  {(posture) => (
                    <PipelineSteps
                      states={stepStates(runStage()!, runStatus(), posture())}
                    />
                  )}
                </Show>
                <span class="text-neutral-400">{fmtAgo(d.startedAt)}</span>
                {d.finishedAt ? (
                  <span class="mono text-neutral-600">
                    {Math.round(
                      (new Date(d.finishedAt).getTime() -
                        new Date(d.startedAt).getTime()) /
                        1000,
                    )}
                    s
                  </span>
                ) : null}
                <div class="ml-auto flex items-center gap-2">
                  {/* 回滚仅对有产物的成功 run 开放（rollbackable 由历史联查 deploy_artifacts 透出）；旧 run 无产物，置灰 */}
                  <button
                    class={button({ variant: "danger", size: "sm" })}
                    disabled={!d.rollbackable}
                    title={
                      d.rollbackable
                        ? `回滚到 run #${d.id}`
                        : "无快照，无法回滚"
                    }
                    onClick={() => {
                      void (async () => {
                        const ok = await confirmAction({
                          title: `回滚到 run #${d.id}？`,
                          body: `提交 ${d.commitSha ?? "无 sha"}——容器将切回当时的镜像与配置。`,
                          confirmLabel: "回滚",
                          danger: true,
                        });
                        if (!ok) return;
                        await unwrap(
                          api
                            .targets({ id: t().id })
                            .rollback.post({ runId: d.id }),
                        );
                        await props.reload();
                        ui.open({ kind: "log", targetId: t().id });
                      })();
                    }}
                  >
                    回滚
                  </button>
                  <button
                    class={button({ variant: "ghost", size: "sm" })}
                    onClick={() =>
                      ui.open({ kind: "log", targetId: t().id, dep: d.id })
                    }
                  >
                    日志
                  </button>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </>
  );
}

function ServiceEnvTab(props: {
  data: ServiceDrawerData;
  svc: string;
  mutate: Mutate;
}) {
  const [rows, setRows] = createSignal<EnvEntry[]>(
    envRowsFromText(props.data.envText ?? ""),
  );
  const [depIds, setDepIds] = createSignal<number[]>(
    props.data.selectedDeps ?? [],
  );
  const t = () => props.data.target;
  return (
    <form
      class="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void props.mutate(
          () =>
            unwrap(
              api
                .targets({ id: t().id })
                .service.env.post({
                  svc: props.svc,
                  envText: envRowsToText(rows()),
                  depIds: depIds(),
                }),
            ),
          { refreshBoard: true, reload: false },
        );
      }}
    >
      <For each={props.data.connections ?? []}>
        {(conn) => <DbConnectionSection conn={conn} />}
      </For>
      <p class="text-xs text-neutral-500">
        随 override compose 注入该服务容器（enc1: 加密保存在控制面本地，不入
        git），重新部署后生效。
      </p>
      <Show when={(props.data.sharedEnv ?? []).length > 0}>
        <Section title="服务器共享变量" hint="选择即写入下方变量">
          <select
            class={field()}
            value=""
            onChange={(e) => {
              const v = e.currentTarget.value;
              if (!v) return;
              const idx = v.indexOf("=");
              setRows((cur) =>
                upsertEnvRow(cur, v.slice(0, idx), v.slice(idx + 1)),
              );
            }}
          >
            <option value="">选择共享变量…</option>
            <For each={props.data.sharedEnv ?? []}>
              {(s) => (
                <option value={`${s.envKey}=${s.url}`}>
                  {s.name}（{s.dbType}）→ {s.envKey}
                </option>
              )}
            </For>
          </select>
        </Section>
      </Show>
      <Show when={(props.data.dbRefs ?? []).length > 0}>
        <Section title="引用数据库" hint="勾选 = 画布连线 + 注入连接串">
          <DbRefPicker
            refs={props.data.dbRefs ?? []}
            selected={depIds()}
            onToggle={(r, on) => {
              setDepIds((cur) =>
                on ? [...cur, r.id] : cur.filter((id) => id !== r.id),
              );
              setRows((cur) =>
                on
                  ? upsertEnvRow(cur, r.envKey, r.url)
                  : removeEnvRowsByValue(cur, r.url),
              );
            }}
          />
        </Section>
      </Show>
      <EnvRowsEditor rows={rows()} onChange={setRows} />
      <SubmitBtn label="保存变量" busyLabel="保存中…" busy={false} />
    </form>
  );
}

/** target 级变量：app 走 .env + 依赖血缘；db 展示连接信息与模板变量。
 *  两处都按「行」编辑，保存时由服务端序列化（下次部署生效）。 */
function TargetEnvTab(props: { data: ServiceDrawerData; mutate: Mutate }) {
  const t = () => props.data.target;
  const isDb = () => t().kind === "db";
  const [rows, setRows] = createSignal<EnvEntry[]>([]);
  const [depIds, setDepIds] = createSignal<number[]>([]);
  const [dbRefs, setDbRefs] = createSignal<DbRef[]>([]);
  const [conns, setConns] = createSignal<DbConnection[]>([]);
  const [loadError, setLoadError] = createSignal<string>();

  onMount(() => {
    unwrap(api.targets({ id: t().id }).env.get())
      .then((d) => {
        setRows(d.entries);
        setDepIds(d.selectedDeps);
        setDbRefs(d.dbRefs);
        setConns(d.connections ?? (d.connection ? [d.connection] : []));
      })
      .catch((e) => setLoadError((e as Error).message));
  });

  /** 逻辑库变量由宿主实例生成：只读 */
  const readOnly = () => isDb() && conns().some((c) => c.logical);

  /** 依赖勾选 = 画布连线 + 写入连接串行；与 ServiceEnvTab/EnvDrawer 的语义一致 */
  const toggleDep = (r: DbRef, on: boolean) => {
    setDepIds((cur) => (on ? [...cur, r.id] : cur.filter((id) => id !== r.id)));
    setRows((cur) =>
      on
        ? upsertEnvRow(cur, r.envKey, r.url)
        : removeEnvRowsByValue(cur, r.url),
    );
  };

  return (
    <form
      class="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void props.mutate(
          () =>
            unwrap(
              api.targets({ id: t().id }).env.post({
                entries: rows(),
                ...(isDb() ? {} : { depIds: depIds() }),
              }),
            ).then(() => ({
              notice: isDb()
                ? "模板变量已保存，重新部署后生效"
                : "变量已保存；引用数据库会自动连线，重新部署后生效",
            })),
          { refreshBoard: true, reload: false },
        );
      }}
    >
      {loadError() ? <ErrorBanner>{loadError()}</ErrorBanner> : null}

      <For each={conns()}>{(conn) => <DbConnectionSection conn={conn} />}</For>
      <Show when={isDb() && conns().length === 0}>
        <p class="text-xs text-neutral-500">连接信息在部署成功后生成。</p>
      </Show>

      <Show when={!isDb()}>
        <p class="text-xs text-neutral-500">
          写入 app 的 .env（enc1: 加密保存在控制面本地，不入
          git），重新部署后生效。变量里出现本空间数据库的连接串时，画布会自动生成依赖线。
        </p>
        <Show when={(props.data.sharedEnv ?? []).length > 0}>
          <Section title="服务器共享变量" hint="选择即写入下方变量">
            <select
              class={field()}
              value=""
              onChange={(e) => {
                const v = e.currentTarget.value;
                if (!v) return;
                const idx = v.indexOf("=");
                setRows((cur) =>
                  upsertEnvRow(cur, v.slice(0, idx), v.slice(idx + 1)),
                );
              }}
            >
              <option value="">选择共享变量…</option>
              <For each={props.data.sharedEnv ?? []}>
                {(s) => (
                  <option value={`${s.envKey}=${s.url}`}>
                    {s.name}（{s.dbType}）→ {s.envKey}
                  </option>
                )}
              </For>
            </select>
          </Section>
        </Show>
        <Show when={dbRefs().length > 0}>
          <Section title="引用数据库" hint="勾选 = 画布连线 + 注入连接串">
            <DbRefPicker
              refs={dbRefs()}
              selected={depIds()}
              onToggle={toggleDep}
            />
          </Section>
        </Show>
      </Show>

      <Section
        title={isDb() ? "模板变量" : "变量"}
        hint={isDb() ? "下次部署生效 · 加密保存" : "加密保存 · 下次部署生效"}
      >
        <Show
          when={!readOnly()}
          fallback={
            <p class="text-xs text-neutral-500">
              逻辑库的变量由宿主实例生成，不可编辑。
            </p>
          }
        >
          <EnvRowsEditor rows={rows()} onChange={setRows} />
        </Show>
      </Section>

      <Show when={!readOnly()}>
        <SubmitBtn label="保存变量" busyLabel="保存中…" busy={false} />
      </Show>
    </form>
  );
}

function HardwareTab(props: {
  data: ServiceDrawerData;
  svc: string;
  mutate: Mutate;
}) {
  const t = () => props.data.target;
  return (
    <Section title="资源限制" hint="override compose · 重新部署生效">
      <form
        class="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          void props.mutate(
            () =>
              unwrap(
                api.targets({ id: t().id }).service.resources.post({
                  svc: props.svc,
                  cpuCores: numOrUndef(String(fd.get("cpuCores") ?? "")),
                  memoryMb: numOrUndef(String(fd.get("memoryMb") ?? "")),
                }),
              ),
            { reload: false },
          );
        }}
      >
        <label class="flex flex-1 flex-col gap-0.5">
          <span class="text-xs text-neutral-500">CPU 上限（核）</span>
          <input
            class={field()}
            type="number"
            step="0.1"
            min="0"
            name="cpuCores"
            value={props.data.resources?.cpuCores ?? ""}
            placeholder="不限"
          />
        </label>
        <label class="flex flex-1 flex-col gap-0.5">
          <span class="text-xs text-neutral-500">内存上限（MB）</span>
          <input
            class={field()}
            type="number"
            min="0"
            name="memoryMb"
            value={props.data.resources?.memoryMb ?? ""}
            placeholder="不限"
          />
        </label>
        <SubmitBtn label="保存" busyLabel="…" busy={false} />
      </form>
    </Section>
  );
}

function SourceTab(props: {
  data: ServiceDrawerData;
  svc?: string;
  mutate: Mutate;
}) {
  const t = () => props.data.target;
  return (
    <>
      <Show
        when={t().kind === "db"}
        fallback={
          <Section title="来源配置" hint="下次部署生效">
            <form
              class="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                void props.mutate(
                  () =>
                    unwrap(
                      api.targets({ id: t().id }).source.post({
                        repoUrl: String(fd.get("repoUrl") ?? "") || undefined,
                        branch: String(fd.get("branch") ?? "") || undefined,
                        composePath:
                          String(fd.get("composePath") ?? "") || undefined,
                        remoteDir:
                          String(fd.get("remoteDir") ?? "") || undefined,
                      }),
                    ),
                  { reload: false },
                );
              }}
            >
              <label class="flex flex-col gap-0.5">
                <span class="text-xs text-neutral-500">
                  GitHub 仓库（本地文件夹导入可留空）
                </span>
                <input
                  class={field()}
                  type="text"
                  name="repoUrl"
                  value={t().repoUrl ?? ""}
                  placeholder="owner/repo"
                />
              </label>
              <div class="grid grid-cols-2 gap-2">
                <label class="flex flex-col gap-0.5">
                  <span class="text-xs text-neutral-500">分支</span>
                  <input
                    class={field()}
                    type="text"
                    name="branch"
                    value={t().branch ?? "main"}
                  />
                </label>
                <label class="flex flex-col gap-0.5">
                  <span class="text-xs text-neutral-500">compose 路径</span>
                  <input
                    class={field()}
                    type="text"
                    name="composePath"
                    value={t().composePath ?? "docker-compose.yml"}
                  />
                </label>
              </div>
              <label class="flex flex-col gap-0.5">
                <span class="text-xs text-neutral-500">远端目录</span>
                <input
                  class={field()}
                  type="text"
                  name="remoteDir"
                  value={t().remoteDir ?? ""}
                  placeholder="~/dockyard/my-app"
                />
              </label>
              <div>
                <SubmitBtn label="保存" busyLabel="…" busy={false} />
              </div>
            </form>
          </Section>
        }
      >
        <Section title="源">
          <div class="rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2.5 text-xs text-neutral-400">
            类型 {t().dbType}
            {t().instanceOf ? "（逻辑库）" : "（实例）"} ·{" "}
            <span class="mono text-neutral-600">{t().remoteDir}</span>
          </div>
        </Section>
      </Show>
      <Show when={props.svc}>
        {(s) => (
          <Section title="服务">
            <div class="mono rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2.5 text-xs text-neutral-400">
              compose 服务 {s()} · {t().composePath}
            </div>
          </Section>
        )}
      </Show>
    </>
  );
}

function NetworkTab(props: {
  data: ServiceDrawerData;
  svc?: string;
  mutate: Mutate;
}) {
  const t = () => props.data.target;
  return (
    <Section title="域名" hint="edge 反代 + 自动证书">
      <div class="flex flex-col gap-1.5">
        <For
          each={(props.data.domains ?? []).filter((d) =>
            props.svc ? d.serviceName === props.svc : true,
          )}
        >
          {(d) => (
            <div class="flex items-center gap-2 rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2 text-xs">
              <span class="mono text-neutral-200">{d.hostname}</span>
              <span class="text-neutral-600">:{d.targetPort}</span>
              {dnsChip(d)}
              {sslChip(d)}
              <button
                class={cx(button({ variant: "danger", size: "sm" }), "ml-auto")}
                onClick={() => {
                  void (async () => {
                    if (
                      !(await confirmAction({
                        title: `解绑 ${d.hostname}？`,
                        confirmLabel: "解绑",
                        danger: true,
                      }))
                    )
                      return;
                    void props.mutate(
                      () =>
                        unwrap(
                          api
                            .targets({ id: t().id })
                            .service.domains({ domainId: d.id })
                            .delete({ query: { svc: props.svc } }),
                        ),
                      { refreshBoard: true },
                    );
                  })();
                }}
              >
                ✕
              </button>
            </div>
          )}
        </For>
        <form
          class="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            void props.mutate(
              () =>
                unwrap(
                  api.targets({ id: t().id }).service.domains.post({
                    svc: props.svc,
                    hostname: String(fd.get("hostname") ?? ""),
                    targetPort: Number(fd.get("targetPort")),
                  }),
                ),
              { refreshBoard: true },
            );
            e.currentTarget.reset();
          }}
        >
          <label class="flex flex-1 flex-col gap-0.5">
            <span class="text-xs text-neutral-500">域名</span>
            <input
              class={field()}
              type="text"
              name="hostname"
              placeholder="api.example.com"
              required
            />
          </label>
          <label class="flex w-20 flex-col gap-0.5">
            <span class="text-xs text-neutral-500">端口</span>
            <input class={field()} type="number" name="targetPort" required />
          </label>
          <SubmitBtn label="绑定" busyLabel="…" busy={false} />
        </form>
      </div>
    </Section>
  );
}

function BackupsTab(props: { data: ServiceDrawerData; mutate: Mutate }) {
  const t = () => props.data.target;
  const restorable = () => Boolean(props.data.backupRestorable);
  // 恢复是破坏性操作：统一走应用内确认框（Esc/遮罩=取消），确认后才提交
  const restore = async (file: string) => {
    const ok = await confirmAction({
      title: "从备份恢复？",
      body: `将用 ${file} 覆盖当前实例的数据。恢复前会自动做一次安全备份，但恢复过程仍可能影响正在使用该库的服务。`,
      confirmLabel: "确认恢复",
      danger: true,
    });
    if (!ok) return;
    await props.mutate(() =>
      unwrap(api.targets({ id: t().id }).restore.post({ file, confirm: true })),
    );
  };
  return (
    <>
      <div>
        <button
          class={button({ variant: "primary", size: "sm" })}
          onClick={() =>
            void props.mutate(() =>
              unwrap(api.targets({ id: t().id }).backup.post()),
            )
          }
        >
          立即备份
        </button>
      </div>
      <div class="flex flex-col">
        <Show when={(props.data.backups ?? []).length === 0}>
          <div class="py-4 text-center text-xs text-neutral-600">
            还没有备份
          </div>
        </Show>
        <For each={props.data.backups ?? []}>
          {(b) => (
            <div class="flex items-center gap-3 border-b border-harbor-800/60 py-2 text-xs">
              <span class="mono text-neutral-300">{b.file}</span>
              <span class="text-neutral-600">{fmtBytes(b.size)}</span>
              <span class="text-neutral-500">{fmtAgo(b.at)}</span>
              <div class="ml-auto flex items-center gap-3">
                <Show when={restorable()}>
                  <button
                    class={button({ variant: "danger", size: "sm" })}
                    onClick={() => void restore(b.file)}
                  >
                    恢复
                  </button>
                </Show>
                <a
                  class="text-tide-400 hover:opacity-80"
                  href={deployPaths.backupsByIdByFile(t().id, b.file)}
                  download={b.file}
                >
                  下载
                </a>
              </div>
            </div>
          )}
        </For>
      </div>
      <p class="text-[11px] text-neutral-600">
        备份保存在控制面本地（~/.local/share/dockyard/backups/）。
        {restorable()
          ? "恢复前会自动安全备份当前数据；仍建议在业务低峰执行。"
          : "该引擎暂不支持自动恢复，请下载后在服务器上手动执行，避免误覆盖。"}
      </p>
    </>
  );
}

// ── 发现容器详情（只读）：docker 里跑着、但 dockyard 没纳管的容器 ──
// 数据来自 /board 快照（点卡片时已在本机），不额外请求；没有部署/回滚/备份入口。

const STATE_LABEL: Record<string, string> = {
  running: "运行中",
  exited: "已停止",
  created: "已创建",
  restarting: "重启中",
  paused: "已暂停",
  dead: "已失效",
  unknown: "未知",
};

export function DiscoveredModal(props: { d: DiscoveredContainer }) {
  const ui = useUi();
  const d = () => props.d;
  const [copied, setCopied] = createSignal(false);
  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(d().id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("复制失败，请手动选中容器 ID", "err");
    }
  };

  const row = (label: string, value: JSX.Element) => (
    <>
      <span class="text-xs text-neutral-500">{label}</span>
      <span class="min-w-0 text-neutral-300">{value}</span>
    </>
  );

  return (
    <Modal title={`容器详情 — ${d().name}`} onClose={ui.close}>
      <div class="flex flex-col gap-5">
        <Notice>
          发现容器未纳入 dockyard
          管理：这里只做只读呈现，不提供部署、回滚或备份。要纳管请走「部署本仓库
          / 添加数据库」。
        </Notice>

        <Section title="容器">
          <div class="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-xs">
            {row(
              "状态",
              d().state === "running" ? (
                <Chip tone="ok">{STATE_LABEL.running}</Chip>
              ) : (
                <Chip tone="warn">{STATE_LABEL[d().state] ?? d().state}</Chip>
              ),
            )}
            {row(
              "镜像",
              <span class="mono break-all text-neutral-200">
                {d().image || "—"}
              </span>,
            )}
            {row(
              "容器 ID",
              <span class="flex items-center gap-2">
                <code class="mono select-all text-neutral-400">{d().id}</code>
                <button
                  class={cx(
                    button({ variant: "ghost", size: "sm" }),
                    "shrink-0",
                  )}
                  onClick={() => void copyId()}
                >
                  {copied() ? "已复制" : "复制"}
                </button>
              </span>,
            )}
          </div>
        </Section>

        <Section title="compose">
          <div class="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-xs">
            {row("服务", <span class="mono">{d().service || "—"}</span>)}
            {row(
              "项目名",
              <span class="mono">{d().composeProject || "—"}</span>,
            )}
          </div>
        </Section>

        <Section title="端口" hint="公网映射 → 容器端口">
          <span class="mono text-xs text-neutral-300">
            {d().ports || "无端口映射"}
          </span>
        </Section>

        <Section title="项目归属">
          <span class="text-xs text-neutral-300">
            {d().projectName
              ? `按 compose working_dir 归属到 ${d().projectName}`
              : "未匹配到 dockyard 项目（只在世界视图显示）"}
          </span>
        </Section>
      </div>
    </Modal>
  );
}
