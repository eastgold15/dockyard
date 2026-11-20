/** @jsxImportSource @solidjs/web */
/**
 * 画布抽屉/弹窗（Solid 版）：数据走 /api/canvas JSON，
 * 写操作 JSON 进出，错误内联回显；结构变更后 emitRefresh() 让画布重拉。
 *
 * React → Solid 转换要点：
 * - useState → createSignal，读取一律函数调用（envText() 等）
 * - useEffect → onSettled（一次性加载/轮询）/ createEffect（跟随信号重拉）
 * - 行内编辑列表用 <For>（原 <Index>）：patchSvc 换对象引用时保 DOM，输入框不丢焦点
 * - React 版靠 key={repoUrl} 重挂载换 defaultValue，Solid 改为信号量受控输入
 * - onChange → 文本/数字用 onInput，select/checkbox/radio 用 onChange（原生语义）
 */
import {
  createEffect,
  createSignal,
  For,
  Match,
  onSettled,
  Show,
  Switch,
} from "solid-js";;;
import type { JSX } from "@solidjs/web";
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
// ── 服务抽屉（Railway Service View）──

import type { Mutate, ServiceDrawerData } from "./service-shared";
import { fmtAgo, fmtBytes } from "./service-shared";
import { numOrUndef } from "./app-detect";
import { dnsChip, sslChip } from "./domains";
export function HardwareTab(props: {
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

export function SourceTab(props: {
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

export function NetworkTab(props: {
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
          )}>
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

export function BackupsTab(props: { data: ServiceDrawerData; mutate: Mutate }) {
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

