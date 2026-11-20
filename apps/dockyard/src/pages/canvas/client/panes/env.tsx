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
} from "solid-js";
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
export const envRowsFromText = (text: string): EnvEntry[] =>
  Object.entries(textToEnvMap(text)).map(([key, v]) => ({
    key,
    value: v.value,
  }));

/** 行列表 → .env 文本（走共享零依赖序列化，引号规则与部署端一致） */
export const envRowsToText = (rows: EnvEntry[]): string =>
  envMapToText(
    Object.fromEntries(
      rows
        .filter((r) => r.key.trim())
        .map((r) => [r.key.trim(), { value: r.value, secret: false }]),
    ),
  );

/** 勾选数据库 = 写入连接串行（同 key 覆盖；多个同类型库自行改变量名） */
export const upsertEnvRow = (
  rows: EnvEntry[],
  key: string,
  value: string,
): EnvEntry[] => {
  const hit = rows.findIndex((r) => r.key === key);
  return hit >= 0
    ? rows.map((r, i) => (i === hit ? { ...r, value } : r))
    : [...rows, { key, value }];
};

export const removeEnvRowsByValue = (rows: EnvEntry[], value: string): EnvEntry[] =>
  rows.filter((r) => r.value !== value);

/** 可编辑变量表：key/value 行 + 增删 + 敏感值显示切换（受控输入，For keyed={false} 保 DOM 不丢焦点） */
export function EnvRowsEditor(props: {
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
      <For each={props.rows} keyed={false}>
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
      </For>
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
export function DbConnectionSection(props: { conn: DbConnection }) {
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

  onSettled(() => {
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


import { DbRefPicker } from "./app-detect";
