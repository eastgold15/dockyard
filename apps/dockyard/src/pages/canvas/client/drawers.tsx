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
import { createEffect, createSignal, Index, For, Match, onCleanup, onMount, Show, splitProps, Switch } from "solid-js";
import type { JSX } from "solid-js";
import type { Deployment, DeployTarget } from "../../deploy/deploy.socket";
import type { Domain } from "../../edge/edge.socket";
import type { RepoBrief } from "../../github/github.socket";
import type { DbRef } from "../../deploy/deploy.socket";
import type { DetectResult, DetectedService } from "../../deploy/deploy.socket";
// env 文本函数从零依赖模块引（detect.ts 依赖链里的 dotenv 无法进浏览器包）
import { serviceEnvToText, textToEnvMap } from "../../../shared/env-text";
import { api, deployPaths, unwrap } from "./api";
import { ConsoleView } from "./console";
import { emitRefresh, useUi } from "./ui";
import { confirmAction } from "./feedback";
import { useDeployLog, useTargetLive } from "./live";

// ── 壳与通用件 ──

const Modal = (props: { title: string; wide?: boolean; children: JSX.Element; onClose: () => void }) => (
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/70" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
    <div class={`${props.wide ? "w-[42rem]" : "w-96"} max-h-[85vh] overflow-y-auto rounded border border-harbor-700 bg-harbor-900 p-5 shadow-2xl`}>
      <div class="mb-4 flex items-center justify-between">
        <h3 class="text-sm font-semibold text-neutral-100">{props.title}</h3>
        <button class="text-neutral-500 hover:text-neutral-200" onClick={props.onClose}>✕</button>
      </div>
      {props.children}
    </div>
  </div>
);

/** 右侧抽屉（Railway 式配置面板） */
const Drawer = (props: { title: string; sub?: string; wide?: boolean; children: JSX.Element; onClose: () => void }) => (
  <div class="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
    <div class={`fixed inset-y-0 right-0 left-auto flex h-full ${props.wide ? "w-[50vw]" : "w-[36rem]"} max-w-full flex-col border-l border-harbor-700 bg-harbor-900 shadow-2xl`}>
      <div class="flex items-start justify-between border-b border-harbor-800 px-5 py-4">
        <div class="flex flex-col gap-1">
          <h3 class="text-sm font-semibold text-neutral-100">{props.title}</h3>
          {props.sub ? <p class="text-xs text-neutral-500">{props.sub}</p> : null}
        </div>
        <button class="text-neutral-500 hover:text-neutral-200" onClick={props.onClose}>✕</button>
      </div>
      <div class="flex-1 overflow-y-auto px-5 py-4">{props.children}</div>
    </div>
  </div>
);

const Section = (props: { title: string; hint?: string; children: JSX.Element }) => (
  <section class="flex flex-col gap-2">
    <div class="flex items-baseline justify-between">
      <h4 class="text-xs font-semibold tracking-wide text-neutral-300 uppercase">{props.title}</h4>
      {props.hint ? <span class="text-[11px] text-neutral-600">{props.hint}</span> : null}
    </div>
    {props.children}
  </section>
);

const ErrorBanner = (props: { children: JSX.Element }) => (
  <div class="rounded bg-signal-500/15 px-3 py-2 text-xs text-signal-500">{props.children}</div>
);

const Notice = (props: { children: JSX.Element }) => (
  <div class="rounded bg-tide-400/10 px-3 py-2 text-xs text-tide-400">{props.children}</div>
);

const Chip = (props: { tone?: "ok" | "warn" | "muted"; children: JSX.Element }) => (
  <span class={`rounded px-1.5 py-0.5 text-[11px] font-medium mono ${
    props.tone === "ok" ? "bg-tide-400/10 text-tide-400"
    : props.tone === "warn" ? "bg-brass-500/15 text-brass-500"
    : "bg-harbor-800 text-neutral-500"
  }`}>{props.children}</span>
);

const inputCls = "rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-200";
const labelCls = "text-[11px] text-neutral-500";

const Field = (props: { label: string } & JSX.InputHTMLAttributes<HTMLInputElement>) => {
  const [local, rest] = splitProps(props, ["label"]);
  return (
    <label class="flex flex-col gap-1 text-sm">
      <span class="text-xs text-neutral-500">{local.label}</span>
      <input class="rounded border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 text-sm text-neutral-200 outline-none focus:border-brass-500" {...rest} />
    </label>
  );
};

/** 提交按钮（busy 状态：识别要调 gh API / 部署要克隆，必须给用户即时反馈） */
const SubmitBtn = (props: { label: string; busyLabel: string; busy: boolean }) => (
  <button
    type="submit"
    disabled={props.busy}
    class="inline-flex items-center justify-center gap-2 rounded bg-brass-500 px-3 py-1.5 text-sm font-semibold text-harbor-950 transition-colors hover:bg-brass-600 disabled:pointer-events-none disabled:opacity-70"
  >
    {props.busy ? <span class="animate-spin">◌</span> : null}
    {props.busy ? props.busyLabel : props.label}
  </button>
);

// ── 共享类型（与 canvas.actions 的 JSON 响应对齐）──

interface Carry { nodeId: number; name: string; repoUrl?: string; branch: string; remoteDir: string }
interface SharedMatch { service: string; name: string; dbType: string; envKey: string; url: string; displayUrl: string }
interface DetectStepData { carry: Carry; detect: DetectResult; envText: string; dbRefs: DbRef[]; sharedMatches: SharedMatch[] }
type NewAppData =
  | { mode: "github"; repos: RepoBrief[]; error?: string; prefillRepo?: string }
  | ({ mode: "local" } & DetectStepData);

// ── 部署 app 向导（Railway/openship 两步式，右侧抽屉）──

export function NewAppWizard(props: { nodeId: number }) {
  const ui = useUi();
  const [data, setData] = createSignal<NewAppData | null>(null);
  const [step2, setStep2] = createSignal<DetectStepData | null>(null);
  const [loadError, setLoadError] = createSignal<string>();

  // nodeId 在抽屉生命周期内不变（宿主 keyed 重建），onMount 拉一次即可
  onMount(() => {
    unwrap(api["new-app"]({ nodeId: props.nodeId }).get())
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
        {(d) => <AppDetectStep data={d()} onBack={d().carry.repoUrl ? () => setStep2(null) : undefined} />}
      </Match>
      <Match when={loadError()}>
        {(err) => <Drawer title="部署 app" onClose={ui.close}><ErrorBanner>{err()}</ErrorBanner></Drawer>}
      </Match>
      <Match when={githubData()}>
        {(d) => <NewAppStep1 nodeId={props.nodeId} repos={d().repos} initialError={d().error} prefillRepo={d().prefillRepo} onDetected={setStep2} />}
      </Match>
      <Match when={true}>
        <Drawer title="部署 app" onClose={ui.close}><div class="text-xs text-neutral-500">加载中…</div></Drawer>
      </Match>
    </Switch>
  );
}

function NewAppStep1(props: {
  nodeId: number; repos: RepoBrief[]; initialError?: string; prefillRepo?: string;
  onDetected: (d: DetectStepData) => void;
}) {
  const ui = useUi();
  const [error, setError] = createSignal(props.initialError);
  const [busy, setBusy] = createSignal(false);
  const [repoUrl, setRepoUrl] = createSignal(props.prefillRepo ?? "");
  // 名称/远端目录跟随仓库名预填但可手改（React 版靠 key={repoUrl} 重挂载换 defaultValue，
  // Solid 无 key 语义，改为信号量受控）
  const [name, setName] = createSignal(props.prefillRepo?.split("/")[1] ?? "");
  const [remoteDir, setRemoteDir] = createSignal(
    props.prefillRepo?.split("/")[1] ? `~/dockyard/${props.prefillRepo.split("/")[1]}` : "",
  );

  const pickRepo = (v: string) => {
    setRepoUrl(v);
    const n = v.split("/")[1] ?? "";
    setName(n);
    setRemoteDir(n ? `~/dockyard/${n}` : "");
  };

  const submit = async (e: SubmitEvent & { currentTarget: HTMLFormElement }) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const d = await unwrap(api.detect.post({
        nodeId: props.nodeId,
        name: name(),
        repoUrl: repoUrl(),
        branch: String(fd.get("branch") ?? "main") || "main",
        remoteDir: remoteDir(),
      }));
      props.onDetected(d);
    } catch (err) {
      setError(`识别失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title="部署 app" sub="从 GitHub 仓库部署到这台服务器" onClose={ui.close}>
      <form class="flex flex-col gap-4" onSubmit={submit}>
        {error() ? <ErrorBanner>{error()}</ErrorBanner> : null}
        <Section title="仓库" hint={`gh 账号下 ${props.repos.length} 个`}>
          <label class="flex flex-col gap-1 text-sm">
            <span class="text-neutral-400">选择仓库（可输入过滤）</span>
            <input
              class="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-200"
              type="text" name="repoUrl" list="gh-repos" placeholder="owner/repo"
              autocomplete="off" value={repoUrl()} onInput={(e) => pickRepo(e.currentTarget.value)} required
            />
            <datalist id="gh-repos">
              <For each={props.repos}>
                {(r) => <option value={r.fullName}>{`${r.private ? "🔒" : "🌐"} ${r.branch}`}</option>}
              </For>
            </datalist>
          </label>
        </Section>
        <Section title="基本">
          <div class="grid grid-cols-2 gap-2">
            <Field label="名称" name="name" placeholder="my-app" required value={name()} onInput={(e) => setName(e.currentTarget.value)} />
            <Field label="分支" name="branch" value="main" />
          </div>
          <Field label="远端目录" name="remoteDir" placeholder="~/dockyard/my-app" required value={remoteDir()} onInput={(e) => setRemoteDir(e.currentTarget.value)} />
        </Section>
        <div class="text-xs text-neutral-500">下一步会读取仓库的 openship.json / compose 自动识别服务、端口与域名。</div>
        <SubmitBtn label="下一步：识别仓库" busyLabel="识别中…（调 GitHub API，通常几秒）" busy={busy()} />
      </form>
    </Drawer>
  );
}

/** 服务行编辑状态（step2 受控） */
interface SvcEdit {
  name: string; exposed: boolean; port?: number; domain?: string;
  cpuCores?: number; memoryMb?: number; envText: string;
}

const svcEditOf = (s: DetectedService): SvcEdit => ({
  name: s.name, exposed: s.exposed, port: s.port, domain: s.domain,
  cpuCores: s.cpuCores, memoryMb: s.memoryMb, envText: serviceEnvToText(s.env),
});

const numOrUndef = (v: string) => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Step 2：识别结果确认。errors 硬阻断，warnings 只提示 */
function AppDetectStep(props: { data: DetectStepData; onBack?: () => void }) {
  const ui = useUi();
  const { carry, detect, dbRefs, sharedMatches } = props.data;
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [services, setServices] = createSignal<SvcEdit[]>(detect.services.map(svcEditOf));
  const [envText, setEnvText] = createSignal(props.data.envText);
  const [composePath, setComposePath] = createSignal(detect.composePath);
  const [depIds, setDepIds] = createSignal<number[]>([]);
  const [reuse, setReuse] = createSignal<ReadonlySet<string>>(new Set(sharedMatches.map((m) => m.service)));

  /** envText 行的声明式增删（替代旧 onchange 行内脚本） */
  const syncEnvLine = (line: string, on: boolean) => {
    const lines = envText().split("\n").filter((l) => l.trim() && l !== line);
    if (on) lines.push(line);
    setEnvText(lines.join("\n"));
  };

  const patchSvc = (name: string, patch: Partial<SvcEdit>) =>
    setServices((cur) => cur.map((s) => (s.name === name ? { ...s, ...patch } : s)));

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { targetId } = await unwrap(api.targets.app.post({
        nodeId: carry.nodeId,
        name: carry.name,
        repoUrl: carry.repoUrl || undefined,
        branch: carry.branch,
        composePath: composePath(),
        remoteDir: carry.remoteDir,
        envText: envText(),
        services: services().map((s) => ({
          name: s.name,
          exposed: s.exposed,
          port: s.exposed ? s.port : undefined,
          domain: s.domain || undefined,
          cpuCores: s.cpuCores,
          memoryMb: s.memoryMb,
          env: textToEnvMap(s.envText),
        })),
        depIds: depIds(),
        reuse: [...reuse()],
      }));
      emitRefresh();
      ui.open({ kind: "log", targetId });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title={carry.name} sub={carry.repoUrl ? `${carry.repoUrl}@${carry.branch}` : "本地文件夹导入"} onClose={ui.close}>
      <form class="flex flex-col gap-5" onSubmit={submit}>
        <div class="flex items-center gap-2 text-xs text-neutral-400">
          识别来源
          {detect.source === "openship.json" ? <Chip tone="ok">openship.json</Chip>
            : detect.source === "compose" ? <Chip tone="warn">compose 探测</Chip>
            : <Chip tone="warn">未识别</Chip>}
        </div>

        {error() ? <ErrorBanner>{error()}</ErrorBanner> : null}
        <For each={detect.errors}>{(er) => <ErrorBanner>{er}</ErrorBanner>}</For>
        <Show when={detect.warnings.length > 0}>
          <div class="rounded bg-brass-500/10 px-3 py-2 text-xs text-brass-500">
            <For each={detect.warnings}>{(w) => <div>⚠️ {w}</div>}</For>
          </div>
        </Show>

        <Show when={services().length > 0}>
          <Section title="服务" hint={`${services().length} 个 · 端口/域名/资源`}>
            {/* Index 按位置渲染：patchSvc 换对象引用时保 DOM，输入不丢焦点 */}
            <Index each={services()}>
              {(svc) => (
                <div class="rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2.5">
                  <div class="mb-2 flex items-center gap-2">
                    <span class="text-xs font-medium text-neutral-200 mono">{svc().name}</span>
                    {svc().exposed ? <Chip tone="ok">对外</Chip> : <Chip>内部</Chip>}
                    <Show when={svc().cpuCores || svc().memoryMb}>
                      <Chip tone="warn">
                        {[svc().cpuCores ? `${svc().cpuCores}C` : "", svc().memoryMb ? `${svc().memoryMb}M` : ""].filter(Boolean).join(" ")}
                      </Chip>
                    </Show>
                  </div>
                  <div class="grid grid-cols-4 gap-2">
                    <label class="flex flex-col gap-0.5">
                      <span class={labelCls}>
                        <input
                          type="checkbox" checked={svc().exposed} class="mr-1 accent-brass-500"
                          onChange={(e) => patchSvc(svc().name, { exposed: e.currentTarget.checked })}
                        />
                        对外端口
                      </span>
                      <input
                        class={`${inputCls} disabled:opacity-40`} type="number" placeholder="内部"
                        value={svc().port ?? ""} disabled={!svc().exposed}
                        onInput={(e) => patchSvc(svc().name, { port: numOrUndef(e.currentTarget.value) })}
                      />
                    </label>
                    <label class="col-span-3 flex flex-col gap-0.5">
                      <span class={labelCls}>绑定域名（留空 = 不绑，需先勾对外）</span>
                      <input class={inputCls} type="text" placeholder="api.example.com" value={svc().domain ?? ""}
                        onInput={(e) => patchSvc(svc().name, { domain: e.currentTarget.value })} />
                    </label>
                    <label class="col-span-2 flex flex-col gap-0.5">
                      <span class={labelCls}>CPU 上限（核）</span>
                      <input class={inputCls} type="number" step="0.1" placeholder="不限" value={svc().cpuCores ?? ""}
                        onInput={(e) => patchSvc(svc().name, { cpuCores: numOrUndef(e.currentTarget.value) })} />
                    </label>
                    <label class="col-span-2 flex flex-col gap-0.5">
                      <span class={labelCls}>内存上限（MB）</span>
                      <input class={inputCls} type="number" placeholder="不限" value={svc().memoryMb ?? ""}
                        onInput={(e) => patchSvc(svc().name, { memoryMb: numOrUndef(e.currentTarget.value) })} />
                    </label>
                  </div>
                  <Show when={svc().envText.trim()}>
                    <details class="mt-2">
                      <summary class="cursor-pointer text-[11px] text-neutral-500 select-none">
                        环境变量 · 随 override 注入容器
                      </summary>
                      <textarea
                        class={`${inputCls} mono mt-1 h-28 w-full px-2 py-1.5 text-[11px] leading-relaxed`}
                        value={svc().envText}
                        onInput={(e) => patchSvc(svc().name, { envText: e.currentTarget.value })}
                      />
                    </details>
                  </Show>
                </div>
              )}
            </Index>
          </Section>
        </Show>

        <Show when={sharedMatches.length > 0}>
          <Section title="复用服务器资源？" hint="前置检查：服务器已有匹配的共享中间件">
            <div class="flex flex-col gap-1.5">
              <For each={sharedMatches}>
                {(m) => (
                  <label class="flex cursor-pointer items-center gap-2 rounded border border-tide-400/30 bg-tide-400/5 px-3 py-2 text-xs text-neutral-300 transition-colors has-checked:border-tide-400/70">
                    <input
                      type="checkbox" checked={reuse().has(m.service)} class="accent-tide-400"
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        const next = new Set(reuse());
                        if (on) next.add(m.service); else next.delete(m.service);
                        setReuse(next);
                        syncEnvLine(`${m.envKey}=${m.url}`, on);
                      }}
                    />
                    <span class="flex min-w-0 flex-col">
                      <span>服务 <span class="mono text-neutral-200">{m.service}</span> 复用共享资源「{m.name}」（{m.dbType}）→ <span class="mono text-tide-400">{m.envKey}</span></span>
                      <span class="mono truncate text-[10px] text-neutral-600">{m.displayUrl}</span>
                    </span>
                  </label>
                )}
              </For>
              <div class="text-[11px] text-neutral-600">勾选 = 跳过该中间件部署，自动注入共享连接串；取消 = 随项目完整部署。</div>
            </div>
          </Section>
        </Show>

        <Show when={dbRefs.length > 0}>
          <Section title="依赖数据库" hint="画布连线 + 注入连接串">
            <DbRefPicker refs={dbRefs} selected={depIds()} onToggle={(r, on) => {
              setDepIds((cur) => (on ? [...cur, r.id] : cur.filter((id) => id !== r.id)));
              syncEnvLine(`${r.envKey}=${r.url}`, on);
            }} />
          </Section>
        </Show>

        <Section title="变量" hint="compose 插值用 · 加密保存">
          <textarea
            class={`${inputCls} mono h-28 px-3 py-2 text-xs leading-relaxed`}
            placeholder="KEY=value" value={envText()} onInput={(e) => setEnvText(e.currentTarget.value)}
          />
        </Section>

        <Section title="打包" hint="compose 构建与部署">
          <label class="flex flex-col gap-1 text-sm">
            <span class="text-neutral-400">compose 文件路径</span>
            <input class={`${inputCls} px-3 py-1.5`} type="text" value={composePath()} required
              onInput={(e) => setComposePath(e.currentTarget.value)} />
          </label>
        </Section>

        <div class="flex flex-col gap-2 border-t border-harbor-800 pt-4">
          <div class="text-xs text-neutral-500">创建后立即部署并打开日志。</div>
          <div class="flex gap-2">
            <Show when={props.onBack}>
              <button type="button" class="rounded border border-harbor-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-harbor-800" onClick={props.onBack}>
                上一步
              </button>
            </Show>
            <SubmitBtn label="创建并部署" busyLabel="创建中…" busy={busy()} />
          </div>
        </div>
      </form>
    </Drawer>
  );
}

/** 数据库依赖选择器：勾选 = 记录血缘（画布连线）+ 把连接串注入 envText */
const DbRefPicker = (props: { refs: DbRef[]; selected: number[]; onToggle: (r: DbRef, on: boolean) => void }) => (
  <div class="flex flex-col gap-1.5">
    <For each={props.refs}>
      {(r) => (
        <label class="flex cursor-pointer items-center gap-2 rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2 text-xs text-neutral-300 transition-colors has-checked:border-brass-500/60 has-checked:bg-brass-500/5">
          <input
            type="checkbox" checked={props.selected.includes(r.id)} class="accent-brass-500"
            onChange={(e) => props.onToggle(r, e.currentTarget.checked)}
          />
          <span class="shrink-0 text-neutral-200">{r.logical ? "⛁" : "🗄"} {r.name}</span>
          <span class="flex min-w-0 flex-col">
            <span class="text-neutral-600">
              {r.dbType}{r.logical ? " · 逻辑库" : ""} → <span class="mono text-tide-400">{r.envKey}</span>
            </span>
            <span class="mono truncate text-[10px] text-neutral-700">{r.displayUrl}</span>
          </span>
        </label>
      )}
    </For>
    <div class="text-[11px] text-neutral-600">勾选即注入连接串到下方变量；取消即移除。多个同类型数据库请自行改变量名。</div>
  </div>
);

// ── 新建数据库 ──

type DbType = "postgres" | "mysql" | "redis" | "mongo";

export function NewDbModal(props: { nodeId: number }) {
  const ui = useUi();
  const [dbType, setDbType] = createSignal<DbType>("postgres");
  const [instances, setInstances] = createSignal<DeployTarget[]>([]);
  const [instanceId, setInstanceId] = createSignal("");
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);

  // 跟随 dbType 重拉同类型实例（等价 React 的 [nodeId, dbType] 依赖）
  createEffect(() => {
    const t = dbType();
    setInstanceId("");
    unwrap(api.instances.get({ query: { nodeId: props.nodeId, dbType: t } }))
      .then((d) => setInstances(d.instances))
      .catch(() => setInstances([]));
  });

  const submit = async (e: SubmitEvent & { currentTarget: HTMLFormElement }) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      await unwrap(api.targets.db.post({
        nodeId: props.nodeId,
        name: String(fd.get("name") ?? ""),
        dbType: dbType(),
        instanceId: instanceId() || undefined,
        remoteDir: String(fd.get("remoteDir") ?? "") || undefined,
      }));
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
        <Field label="名称" name="name" placeholder="my-pg" required />
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-neutral-400">类型</span>
          <select
            class="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-200"
            value={dbType()} onChange={(e) => setDbType(e.currentTarget.value as DbType)}
          >
            <option value="postgres">PostgreSQL</option>
            <option value="mysql">MySQL</option>
            <option value="redis">Redis</option>
            <option value="mongo">MongoDB</option>
          </select>
        </label>
        <div class="flex flex-col gap-1.5 text-sm">
          <label class="flex items-center gap-2 text-neutral-300">
            <input type="radio" name="instanceId" value="" checked={instanceId() === ""} onChange={() => setInstanceId("")} /> 新建实例
          </label>
          <For each={instances()}>
            {(i) => (
              <label class="flex items-center gap-2 text-neutral-300">
                <input type="radio" name="instanceId" value={String(i.id)} checked={instanceId() === String(i.id)} onChange={() => setInstanceId(String(i.id))} />
                在「{i.name}」中新建逻辑库（省一个容器的开销）
              </label>
            )}
          </For>
          <Show when={instances().length > 0}>
            <div class="text-xs text-neutral-500">选现有实例时无需填远端目录，凭据自动生成。</div>
          </Show>
        </div>
        <Field label="远端目录" name="remoteDir" placeholder="~/dockyard/my-pg（新建实例时必填）" />
        {error() ? <ErrorBanner>{error()}</ErrorBanner> : null}
        <div class="text-xs text-neutral-500">凭据自动生成并加密保存，数据卷持久化。</div>
        <SubmitBtn label="创建并部署" busyLabel="创建中…" busy={busy()} />
      </form>
    </Modal>
  );
}

// ── 域名管理 ──

const dnsChip = (d: Domain) =>
  d.dnsStatus === "ok" ? <Chip tone="ok">DNS ✓</Chip>
  : d.dnsStatus === "mismatch" ? <Chip tone="warn">DNS 未指向本机</Chip>
  : <Chip>DNS 未检测</Chip>;
const sslChip = (d: Domain) =>
  d.sslStatus === "active" ? <Chip tone="ok">🔒 HTTPS</Chip>
  : d.sslStatus === "pending" ? <Chip tone="warn">证书待签发</Chip>
  : d.sslStatus === "error" ? <Chip tone="warn">证书异常</Chip>
  : <Chip>无证书</Chip>;

interface DomainsData { target: DeployTarget; domains: Domain[] }

export function DomainsModal(props: { targetId: number }) {
  const ui = useUi();
  const [data, setData] = createSignal<DomainsData | null>(null);
  const [error, setError] = createSignal<string>();

  const load = () => {
    unwrap(api.targets({ id: props.targetId }).domains.get()).then(setData).catch((e) => setError((e as Error).message));
  };
  onMount(load);

  const remove = async (d: Domain) => {
    if (!(await confirmAction({ title: `解绑 ${d.hostname}？`, confirmLabel: "解绑", danger: true }))) return;
    try {
      await unwrap(api.domains({ id: d.id }).delete());
      emitRefresh();
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const submit = async (e: SubmitEvent & { currentTarget: HTMLFormElement }) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(undefined);
    try {
      await unwrap(api.targets({ id: props.targetId }).domains.post({
        hostname: String(fd.get("hostname") ?? ""),
        targetPort: Number(fd.get("targetPort")),
      }));
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
          <div class="text-xs text-neutral-500">还没有绑定域名。绑定后自动反代并签发 HTTPS 证书。</div>
        </Show>
        <For each={data()?.domains ?? []}>
          {(d) => (
            <div class="flex items-center justify-between gap-2 rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2">
              <div class="flex flex-col gap-1">
                <a class="text-xs font-medium text-tide-400 hover:text-tide-300 mono" href={`https://${d.hostname}`} target="_blank" rel="noreferrer">{d.hostname}</a>
                <span class="text-[11px] text-neutral-500 mono">→ :{d.targetPort}{d.serviceName ? `（${d.serviceName}）` : ""}</span>
              </div>
              <div class="flex items-center gap-1.5">
                {dnsChip(d)}{sslChip(d)}
                <button class="text-neutral-600 hover:text-signal-500" onClick={() => void remove(d)}>✕</button>
              </div>
            </div>
          )}
        </For>
        <form class="flex items-end gap-2" onSubmit={submit}>
          <label class="flex flex-1 flex-col gap-0.5">
            <span class={labelCls}>域名</span>
            <input class={inputCls} type="text" name="hostname" placeholder="app.example.com" required />
          </label>
          <label class="flex w-24 flex-col gap-0.5">
            <span class={labelCls}>端口</span>
            <input class={inputCls} type="number" name="targetPort" required />
          </label>
          <button type="submit" class="rounded bg-brass-500 px-3 py-1.5 text-sm font-semibold text-harbor-950 hover:bg-brass-600">绑定</button>
        </form>
        <div class="text-xs text-neutral-500">域名 A 记录指向服务器 IP 后，证书会自动签发。</div>
      </div>
    </Modal>
  );
}

// ── 变量抽屉（已有 app 改 .env + 数据库依赖）──

interface EnvData { target: DeployTarget; envText: string; dbRefs: DbRef[]; selectedDeps: number[] }

export function EnvDrawer(props: { targetId: number }) {
  const ui = useUi();
  const [data, setData] = createSignal<EnvData | null>(null);
  const [envText, setEnvText] = createSignal("");
  const [depIds, setDepIds] = createSignal<number[]>([]);
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    unwrap(api.targets({ id: props.targetId }).env.get()).then((d) => {
      setData(d);
      setEnvText(d.envText);
      setDepIds(d.selectedDeps);
    }).catch((e) => setError((e as Error).message));
  });

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await unwrap(api.targets({ id: props.targetId }).env.post({ envText: envText(), depIds: depIds() }));
      emitRefresh();
      ui.close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title={`变量 — ${data()?.target.name ?? "…"}`} sub="保存后重新部署生效" onClose={ui.close}>
      <form class="flex flex-col gap-5" onSubmit={submit}>
        {error() ? <ErrorBanner>{error()}</ErrorBanner> : null}
        <Show when={data() && data()!.dbRefs.length > 0}>
          <Section title="依赖数据库" hint="画布连线 + 注入连接串">
            <DbRefPicker refs={data()!.dbRefs} selected={depIds()} onToggle={(r, on) => {
              setDepIds((cur) => (on ? [...cur, r.id] : cur.filter((id) => id !== r.id)));
              const line = `${r.envKey}=${r.url}`;
              const lines = envText().split("\n").filter((l) => l.trim() && l !== line);
              if (on) lines.push(line);
              setEnvText(lines.join("\n"));
            }} />
          </Section>
        </Show>
        <Section title="变量" hint="compose 插值用 · 加密保存">
          <textarea
            class={`${inputCls} mono h-56 px-3 py-2 text-xs leading-relaxed`}
            placeholder="KEY=value" value={envText()} onInput={(e) => setEnvText(e.currentTarget.value)}
          />
        </Section>
        <SubmitBtn label="保存变量" busyLabel="保存中…" busy={busy()} />
      </form>
    </Drawer>
  );
}

// ── 部署日志（HTTP 回填 + SSE 增量，终态最后一次 HTTP 对齐防丢行）──

// 与服务端返回对齐：dep 缺部署记录时是 undefined（Eden 推断的真实形状）
interface LogData { target: DeployTarget; dep?: Deployment | null }

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
    const res = await fetch(`${deployPaths.targetsByIdLogBody(props.targetId)}${props.dep ? `?dep=${props.dep}` : ""}`);
    return res.text();
  };

  onMount(async () => {
    try {
      const d = await unwrap(api.targets({ id: props.targetId }).log.get({ query: { dep: props.dep } }));
      setData(d);
      const text = await fetchBody();
      setBackfill(text || "尚未部署");
    } catch {
      setBackfill("加载失败");
    }
  });

  // 终态对齐：live 状态进入 success/failed 时做最后一次 HTTP 全量回填
  createEffect(() => {
    const s = live().status;
    const depId = data()?.dep?.id;
    if (!depId || finalText() !== null || (s !== "success" && s !== "failed")) return;
    void (async () => {
      try {
        const head = await unwrap(api.targets({ id: props.targetId }).log.get({ query: { dep: props.dep } }));
        setData(head);
        setFinalText((await fetchBody()) || "尚未部署");
      } catch { /* 对齐失败则维持 SSE/backfill 显示 */ }
    })();
  });

  // 显示优先级：终态全文 > 当前 run 的 SSE 实时行 > 初始回填
  const logText = () => {
    const fin = finalText();
    if (fin !== null) return fin;
    const dep = data()?.dep;
    const lg = liveLog();
    if (dep && lg && lg.runId === dep.id && lg.lines.length) return lg.lines.join("\n");
    return backfill();
  };

  const depStatus = () => live().status ?? data()?.dep?.status;
  return (
    <Modal title={`部署日志 — ${data()?.target.name ?? "…"}`} wide onClose={ui.close}>
      <Show when={depStatus()}>
        {(s) => (
          <div class="mb-2">
            <Chip tone={s() === "success" ? "ok" : s() === "failed" ? "warn" : "muted"}>{s()}</Chip>
          </div>
        )}
      </Show>
      <pre class="mono max-h-96 overflow-auto rounded bg-harbor-950 p-3 text-xs whitespace-pre-wrap text-neutral-300">
        {logText()}
      </pre>
    </Modal>
  );
}

// ── 服务抽屉（Railway Service View）──

type ServiceTab = "deployments" | "source" | "hardware" | "network" | "env" | "monitor" | "console" | "backups";

interface Metrics { state: string; cpuPercent: number; memUsage: number; memLimit: number; netRx: number; netTx: number }

interface ServiceDrawerData {
  target: DeployTarget;
  svc?: string;
  tab: ServiceTab;
  deployments?: Deployment[];
  envText?: string;
  dbRefs?: DbRef[];
  sharedEnv?: { resourceId: number; name: string; dbType: string; envKey: string; url: string }[];
  selectedDeps?: number[];
  domains?: Domain[];
  resources?: { cpuCores?: number; memoryMb?: number };
  backups?: { file: string; size: number; at: string | Date }[];
  metrics?: Metrics | null;
}

const fmtBytes = (n: number) =>
  n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;

const fmtAgo = (d: Date | string) => {
  const s = Math.max(1, Math.round((Date.now() - new Date(d).getTime()) / 1000));
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
        const m = await unwrap(api.targets({ id: props.targetId }).service.metrics.get({ query: { svc: props.svc } }));
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
        <div class="rounded bg-harbor-950 px-3 py-2 text-xs text-neutral-500">加载中…</div>
      </Match>
      <Match when={stats() === null}>
        <div class="rounded bg-harbor-950 px-3 py-2 text-xs text-neutral-500">指标不可用（容器未运行或服务器离线）</div>
      </Match>
      <Match when={stats()!.state !== "running" ? stats() : null}>
        {(m) => <div class="rounded bg-harbor-950 px-3 py-2 text-xs text-neutral-500">容器状态:{m()!.state}</div>}
      </Match>
      <Match when={stats()}>
        {(m) => (
          <div class="flex flex-col gap-3">
            <For each={[
              { label: "CPU", pct: Math.min(100, m()!.cpuPercent), text: `${m()!.cpuPercent}%` },
              { label: "内存", pct: m()!.memLimit ? Math.min(100, (m()!.memUsage / m()!.memLimit) * 100) : 0, text: `${fmtBytes(m()!.memUsage)} / ${fmtBytes(m()!.memLimit)}` },
            ]}>
              {(row) => (
                <div class="flex flex-col gap-1">
                  <div class="flex justify-between text-xs text-neutral-400"><span>{row.label}</span><span class="mono">{row.text}</span></div>
                  <div class="h-1.5 overflow-hidden rounded bg-harbor-800">
                    <div class={`h-full rounded ${row.pct > 85 ? "bg-signal-500" : "bg-tide-400"}`} style={{ width: `${row.pct.toFixed(1)}%` }} />
                  </div>
                </div>
              )}
            </For>
            <div class="flex justify-between text-xs text-neutral-400">
              <span>网络</span>
              <span class="mono">↓ {fmtBytes(m()!.netRx)} · ↑ {fmtBytes(m()!.netTx)}</span>
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
    const tick = async () => {
      try {
        const res = await fetch(`${deployPaths.targetsByIdServiceLogs(props.targetId)}${props.svc ? `?svc=${encodeURIComponent(props.svc)}` : ""}`);
        setText(await res.text());
      } catch { /* 下轮再说 */ }
    };
    void tick();
    const timer = setInterval(tick, 2000);
    onCleanup(() => clearInterval(timer));
  });
  return (
    <pre class="mono max-h-[40vh] overflow-auto rounded bg-harbor-950 p-3 text-xs leading-relaxed whitespace-pre-wrap text-neutral-300">
      {text()}
    </pre>
  );
};

export function ServiceDrawer(props: { targetId: number; svc?: string; initialTab?: string }) {
  const ui = useUi();
  const [tab, setTab] = createSignal<ServiceTab>(
    (["deployments", "source", "hardware", "network", "env", "monitor", "console", "backups"].includes(props.initialTab ?? "")
      ? props.initialTab
      : "deployments") as ServiceTab,
  );
  const [data, setData] = createSignal<ServiceDrawerData | null>(null);
  const [notice, setNotice] = createSignal<string>();
  const [error, setError] = createSignal<string>();

  const load = async () => {
    try {
      const d = await unwrap(api.targets({ id: props.targetId }).service.get({ query: { tab: tab(), svc: props.svc } }));
      setData(d);
    } catch (e) {
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
  const mutate = async (fn: () => Promise<{ notice?: string }>, opts: { refreshBoard?: boolean; reload?: boolean } = {}) => {
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
  const tabs = (): { key: ServiceTab; label: string }[] => [
    { key: "source", label: "Source" },
    ...(props.svc ? [{ key: "hardware" as const, label: "Hardware" }] : []),
    { key: "network", label: "Network" },
    ...(props.svc ? [{ key: "env" as const, label: "Env" }] : []),
    { key: "monitor", label: "Monitor" },
    { key: "console", label: "Console" },
    { key: "deployments", label: "Deployments" },
    ...(isDbInstance() ? [{ key: "backups" as const, label: "Backups" }] : []),
  ];

  return (
    <Drawer wide title={props.svc ? `${target()?.name ?? "…"} / ${props.svc}` : target()?.name ?? "…"} sub={props.svc ? "服务" : target()?.kind === "db" ? "数据库" : "应用"} onClose={ui.close}>
      <div class="flex flex-col gap-4">
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
              <Show when={tab() === "deployments"}><DeploymentsTab data={d()} svc={props.svc} mutate={mutate} /></Show>
              <Show when={tab() === "monitor"}>
                <MetricsPanel targetId={props.targetId} svc={props.svc} />
                <Section title="日志" hint="2s 轮询">
                  <ServiceLogs targetId={props.targetId} svc={props.svc} />
                </Section>
              </Show>
              <Show when={tab() === "console"}>
                <div class="flex flex-col gap-2">
                  <p class="text-xs text-neutral-500">进入{props.svc ? `服务 ${props.svc}` : "容器"}的交互式终端（docker exec）。关闭抽屉即断开。</p>
                  <div class="h-[55vh] overflow-hidden rounded border border-harbor-800 bg-[#0b0f14] p-1">
                    <ConsoleView targetId={props.targetId} service={props.svc} />
                  </div>
                </div>
              </Show>
              <Show when={tab() === "env" && props.svc ? props.svc : null}>
                {(s) => <ServiceEnvTab data={d()} svc={s()} mutate={mutate} />}
              </Show>
              <Show when={tab() === "hardware" && props.svc ? props.svc : null}>
                {(s) => <HardwareTab data={d()} svc={s()} mutate={mutate} />}
              </Show>
              <Show when={tab() === "source"}><SourceTab data={d()} svc={props.svc} mutate={mutate} /></Show>
              <Show when={tab() === "network"}><NetworkTab data={d()} svc={props.svc} mutate={mutate} /></Show>
              <Show when={tab() === "backups" && isDbInstance()}><BackupsTab data={d()} mutate={mutate} /></Show>
            </>
          )}
        </Show>
      </div>
    </Drawer>
  );
}

type Mutate = (fn: () => Promise<{ notice?: string }>, opts?: { refreshBoard?: boolean; reload?: boolean }) => Promise<void>;

function DeploymentsTab(props: { data: ServiceDrawerData; svc?: string; mutate: Mutate }) {
  const ui = useUi();
  const t = () => props.data.target;
  return (
    <>
      <div class="flex items-center gap-2">
        <button
          class="rounded bg-brass-500 px-3 py-1.5 text-xs font-semibold text-harbor-950 hover:bg-brass-600"
          onClick={async () => {
            await unwrap(api.targets({ id: t().id }).deploy.post());
            ui.open({ kind: "log", targetId: t().id });
          }}
        >
          重新部署
        </button>
        <button
          class="rounded border border-harbor-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-harbor-800"
          onClick={() => void props.mutate(() => unwrap(api.targets({ id: t().id }).service.restart.post({ svc: props.svc })), { reload: false })}
        >
          重启{props.svc ? "服务" : "容器"}
        </button>
        {/* 本地导入 app 的显式通道：构建产物推到远端（跨区移动的门票），不起容器 */}
        <Show when={t().kind === "app" && !t().repoUrl}>
          <button
            class="rounded border border-harbor-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-harbor-800"
            title={t().artifactShipped ? "产物已传输过（可再传更新）" : "跨区移动前必须先传输产物"}
            onClick={async () => {
              await unwrap(api.targets({ id: t().id }).ship.post());
              ui.open({ kind: "log", targetId: t().id });
            }}
          >
            传输产物{t().artifactShipped ? " ✓" : ""}
          </button>
        </Show>
        {/* 部署策略三态：manual 不轮询 / notify 只亮徽章 / auto 检出更新即部署 */}
        <select
          class={`${inputCls} ml-auto px-2 py-1.5 text-xs`}
          value={t().deployPolicy}
          title="检出更新时：手动部署=不轮询；仅提醒=亮「有更新」徽章；自动部署=立即触发"
          onChange={(e) => void props.mutate(
            () => unwrap(api.targets({ id: t().id }).policy.post({ policy: e.currentTarget.value as "manual" | "notify" | "auto" })),
            { reload: false },
          )}
        >
          <option value="manual">手动部署</option>
          <option value="notify">仅提醒</option>
          <option value="auto">自动部署</option>
        </select>
      </div>
      <div class="flex flex-col">
        <Show when={(props.data.deployments ?? []).length === 0}>
          <div class="py-4 text-center text-xs text-neutral-600">还没有部署记录</div>
        </Show>
        <For each={props.data.deployments ?? []}>
          {(d) => (
            <div class="flex items-center gap-3 border-b border-harbor-800/60 py-2 text-xs">
              <Chip tone={d.status === "success" ? "ok" : d.status === "failed" ? "warn" : "muted"}>{d.status}</Chip>
              <span class="text-neutral-500">#{d.id}</span>
              {/* 触发来源：手动/自动/回滚（回滚带血缘号） */}
              <Show when={d.trigger && d.trigger !== "ui"}>
                <span class="rounded border border-harbor-700 px-1 text-[10px] text-neutral-500">
                  {d.trigger === "rollback" ? `回滚←#${d.rollbackOf}` : "自动"}
                </span>
              </Show>
              <span class="text-neutral-400">{fmtAgo(d.startedAt)}</span>
              {d.finishedAt ? <span class="mono text-neutral-600">{Math.round((new Date(d.finishedAt).getTime() - new Date(d.startedAt).getTime()) / 1000)}s</span> : null}
              <div class="ml-auto flex items-center gap-2">
                {/* 回滚仅对有快照的成功 run 开放；旧 run（迁移前）无快照，置灰 */}
                <button
                  class="text-neutral-500 hover:text-brass-400 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={!(d.status === "success" && d.snapshotJson)}
                  title={d.status === "success" && d.snapshotJson ? `回滚到 run #${d.id}` : "无快照，无法回滚"}
                  onClick={() => {
                    void (async () => {
                      const ok = await confirmAction({
                        title: `回滚到 run #${d.id}？`,
                        body: `提交 ${d.commitSha ?? "无 sha"}——容器将切回当时的镜像与配置。`,
                        confirmLabel: "回滚",
                        danger: true,
                      });
                      if (!ok) return;
                      await unwrap(api.targets({ id: t().id }).rollback.post({ runId: d.id }));
                      ui.open({ kind: "log", targetId: t().id });
                    })();
                  }}
                >
                  回滚
                </button>
                <button
                  class="text-tide-400 hover:text-tide-300"
                  onClick={() => ui.open({ kind: "log", targetId: t().id, dep: d.id })}
                >
                  日志
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
    </>
  );
}

function ServiceEnvTab(props: { data: ServiceDrawerData; svc: string; mutate: Mutate }) {
  const [envText, setEnvText] = createSignal(props.data.envText ?? "");
  const [depIds, setDepIds] = createSignal<number[]>(props.data.selectedDeps ?? []);
  const t = () => props.data.target;
  return (
    <form
      class="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void props.mutate(() => unwrap(api.targets({ id: t().id }).service.env.post({ svc: props.svc, envText: envText(), depIds: depIds() })), { refreshBoard: true, reload: false });
      }}
    >
      <p class="text-xs text-neutral-500">
        随 override compose 注入该服务容器（enc1: 加密保存在控制面本地，不入 git），重新部署后生效。
      </p>
      <Show when={(props.data.sharedEnv ?? []).length > 0}>
        <Section title="服务器共享变量" hint="选择即追加连接串到下方变量">
          <select
            class={`${inputCls} px-2 py-1.5`} value=""
            onChange={(e) => {
              if (e.currentTarget.value) setEnvText((cur) => (cur.trim() ? `${cur.trim()}\n` : "") + e.currentTarget.value);
            }}
          >
            <option value="">选择共享变量…</option>
            <For each={props.data.sharedEnv ?? []}>
              {(s) => <option value={`${s.envKey}=${s.url}`}>{s.name}（{s.dbType}）→ {s.envKey}</option>}
            </For>
          </select>
        </Section>
      </Show>
      <Show when={(props.data.dbRefs ?? []).length > 0}>
        <Section title="引用数据库" hint="勾选 = 画布连线 + 连接串追加进变量">
          <DbRefPicker refs={props.data.dbRefs ?? []} selected={depIds()} onToggle={(r, on) => {
            setDepIds((cur) => (on ? [...cur, r.id] : cur.filter((id) => id !== r.id)));
            const line = `${r.envKey}=${r.url}`;
            const lines = envText().split("\n").filter((l) => l.trim() && l !== line);
            if (on) lines.push(line);
            setEnvText(lines.join("\n"));
          }} />
        </Section>
      </Show>
      <textarea
        class={`${inputCls} mono h-56 px-3 py-2 text-xs leading-relaxed`}
        placeholder="KEY=value" value={envText()} onInput={(e) => setEnvText(e.currentTarget.value)}
      />
      <SubmitBtn label="保存变量" busyLabel="保存中…" busy={false} />
    </form>
  );
}

function HardwareTab(props: { data: ServiceDrawerData; svc: string; mutate: Mutate }) {
  const t = () => props.data.target;
  return (
    <Section title="资源限制" hint="override compose · 重新部署生效">
      <form
        class="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          void props.mutate(
            () => unwrap(api.targets({ id: t().id }).service.resources.post({
              svc: props.svc,
              cpuCores: numOrUndef(String(fd.get("cpuCores") ?? "")),
              memoryMb: numOrUndef(String(fd.get("memoryMb") ?? "")),
            })),
            { reload: false },
          );
        }}
      >
        <label class="flex flex-1 flex-col gap-0.5">
          <span class={labelCls}>CPU 上限（核）</span>
          <input class={inputCls} type="number" step="0.1" min="0" name="cpuCores" value={props.data.resources?.cpuCores ?? ""} placeholder="不限" />
        </label>
        <label class="flex flex-1 flex-col gap-0.5">
          <span class={labelCls}>内存上限（MB）</span>
          <input class={inputCls} type="number" min="0" name="memoryMb" value={props.data.resources?.memoryMb ?? ""} placeholder="不限" />
        </label>
        <SubmitBtn label="保存" busyLabel="…" busy={false} />
      </form>
    </Section>
  );
}

function SourceTab(props: { data: ServiceDrawerData; svc?: string; mutate: Mutate }) {
  const t = () => props.data.target;
  return (
    <>
      <Show when={t().kind === "db"} fallback={
        <Section title="来源配置" hint="下次部署生效">
          <form
            class="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              void props.mutate(
                () => unwrap(api.targets({ id: t().id }).source.post({
                  repoUrl: String(fd.get("repoUrl") ?? "") || undefined,
                  branch: String(fd.get("branch") ?? "") || undefined,
                  composePath: String(fd.get("composePath") ?? "") || undefined,
                  remoteDir: String(fd.get("remoteDir") ?? "") || undefined,
                })),
                { reload: false },
              );
            }}
          >
            <label class="flex flex-col gap-0.5">
              <span class={labelCls}>GitHub 仓库（本地文件夹导入可留空）</span>
              <input class={inputCls} type="text" name="repoUrl" value={t().repoUrl ?? ""} placeholder="owner/repo" />
            </label>
            <div class="grid grid-cols-2 gap-2">
              <label class="flex flex-col gap-0.5">
                <span class={labelCls}>分支</span>
                <input class={inputCls} type="text" name="branch" value={t().branch ?? "main"} />
              </label>
              <label class="flex flex-col gap-0.5">
                <span class={labelCls}>compose 路径</span>
                <input class={inputCls} type="text" name="composePath" value={t().composePath ?? "docker-compose.yml"} />
              </label>
            </div>
            <label class="flex flex-col gap-0.5">
              <span class={labelCls}>远端目录</span>
              <input class={inputCls} type="text" name="remoteDir" value={t().remoteDir ?? ""} placeholder="~/dockyard/my-app" />
            </label>
            <div><SubmitBtn label="保存" busyLabel="…" busy={false} /></div>
          </form>
        </Section>
      }>
        <Section title="源">
          <div class="rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2.5 text-xs text-neutral-400">
            类型 {t().dbType}{t().instanceOf ? "（逻辑库）" : "（实例）"} · <span class="mono text-neutral-600">{t().remoteDir}</span>
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

function NetworkTab(props: { data: ServiceDrawerData; svc?: string; mutate: Mutate }) {
  const t = () => props.data.target;
  return (
    <Section title="域名" hint="edge 反代 + 自动证书">
      <div class="flex flex-col gap-1.5">
        <For each={(props.data.domains ?? []).filter((d) => (props.svc ? d.serviceName === props.svc : true))}>
          {(d) => (
            <div class="flex items-center gap-2 rounded border border-harbor-800 bg-harbor-950/70 px-3 py-2 text-xs">
              <span class="mono text-neutral-200">{d.hostname}</span>
              <span class="text-neutral-600">:{d.targetPort}</span>
              {dnsChip(d)}{sslChip(d)}
              <button
                class="ml-auto text-neutral-600 hover:text-signal-500"
                onClick={() => {
                  void (async () => {
                    if (!(await confirmAction({ title: `解绑 ${d.hostname}？`, confirmLabel: "解绑", danger: true }))) return;
                    void props.mutate(
                      () => unwrap(api.targets({ id: t().id }).service.domains({ domainId: d.id }).delete({ query: { svc: props.svc } })),
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
              () => unwrap(api.targets({ id: t().id }).service.domains.post({
                svc: props.svc,
                hostname: String(fd.get("hostname") ?? ""),
                targetPort: Number(fd.get("targetPort")),
              })),
              { refreshBoard: true },
            );
            e.currentTarget.reset();
          }}
        >
          <label class="flex flex-1 flex-col gap-0.5">
            <span class={labelCls}>域名</span>
            <input class={inputCls} type="text" name="hostname" placeholder="api.example.com" required />
          </label>
          <label class="flex w-20 flex-col gap-0.5">
            <span class={labelCls}>端口</span>
            <input class={inputCls} type="number" name="targetPort" required />
          </label>
          <SubmitBtn label="绑定" busyLabel="…" busy={false} />
        </form>
      </div>
    </Section>
  );
}

function BackupsTab(props: { data: ServiceDrawerData; mutate: Mutate }) {
  const t = () => props.data.target;
  return (
    <>
      <div>
        <button
          class="rounded bg-brass-500 px-3 py-1.5 text-xs font-semibold text-harbor-950 hover:bg-brass-600"
          onClick={() => void props.mutate(() => unwrap(api.targets({ id: t().id }).backup.post()))}
        >
          立即备份
        </button>
      </div>
      <div class="flex flex-col">
        <Show when={(props.data.backups ?? []).length === 0}>
          <div class="py-4 text-center text-xs text-neutral-600">还没有备份</div>
        </Show>
        <For each={props.data.backups ?? []}>
          {(b) => (
            <div class="flex items-center gap-3 border-b border-harbor-800/60 py-2 text-xs">
              <span class="mono text-neutral-300">{b.file}</span>
              <span class="text-neutral-600">{fmtBytes(b.size)}</span>
              <span class="text-neutral-500">{fmtAgo(b.at)}</span>
              <a class="ml-auto text-tide-400 hover:text-tide-300" href={deployPaths.backupsByIdByFile(t().id, b.file)} download={b.file}>
                下载
              </a>
            </div>
          )}
        </For>
      </div>
      <p class="text-[11px] text-neutral-600">备份保存在控制面本地（~/.local/share/dockyard/backups/）。恢复请下载后在服务器上手动执行，避免误覆盖。</p>
    </>
  );
}
