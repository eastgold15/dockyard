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

