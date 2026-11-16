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
// ── 服务抽屉（Railway Service View）──

import type { Mutate, ServiceDrawerData } from "./service-shared";
export function ServiceEnvTab(props: {
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
export function TargetEnvTab(props: { data: ServiceDrawerData; mutate: Mutate }) {
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

import { DbRefPicker } from "./app-detect";
import { DbConnectionSection, EnvRowsEditor, envRowsFromText, envRowsToText, removeEnvRowsByValue, upsertEnvRow } from "./env";
import { dnsChip, sslChip } from "./domains";
