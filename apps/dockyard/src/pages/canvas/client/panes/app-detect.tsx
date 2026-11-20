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
} from "@/pages/deploy/deploy.socket";
import type { Domain } from "@/pages/edge/edge.socket";
import type { RepoBrief } from "@/pages/github/github.socket";
import type { DbConnection, DbRef, EnvEntry } from "@/pages/deploy/deploy.socket";
import type { DetectResult, DetectedService } from "@/pages/deploy/deploy.socket";
import type { DiscoveredContainer } from "../../canvas.model";
import copy from "copy-to-clipboard";
// env 文本函数从零依赖模块引（detect.ts 依赖链里的 dotenv 无法进浏览器包）
import { envMapToText, serviceEnvToText, textToEnvMap } from "@/shared/env-text";
import { api, deployPaths, unwrap } from "../infra/api";
import { ConsoleView } from "./console";
import { LogView } from "./log-view";
import { emitRefresh, useUi } from "../infra/ui";
import { confirmAction, toast } from "@/shared/solid-ui/feedback";
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
export const numOrUndef = (v: string) => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : undefined;
};

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


/** 构建方式分类（镜像名/服务名启发式，与 detect.guessDbType 同口径）：db → 拉取镜像，app → 构建镜像 */
export const DB_SERVICE_RE =
  /postgres|pgvector|postgis|mysql|mariadb|redis|valkey|dragonfly|mongo/;
export const isDbService = (s: { name: string; image?: string }) =>
  DB_SERVICE_RE.test(`${s.image ?? ""} ${s.name}`.toLowerCase());

/** Step 2：识别结果确认。errors 硬阻断，warnings 只提示 */
export function AppDetectStep(props: { data: DetectStepData; onBack?: () => void }) {
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
export const DbRefPicker = (props: {
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

