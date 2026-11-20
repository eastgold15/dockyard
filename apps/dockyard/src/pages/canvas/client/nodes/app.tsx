/** @jsxImportSource @solidjs/web */
/** app 卡：一个 div 盒子。项目名 header（顶部）+ 服务名/域名纯粹流式行（不嵌套子节点）。
 *  部署/变量/域名/日志/移除全部收进 Sidebar——数据库卡同样式，一个长方体 */
import {
  For,
  Show,
} from "solid-js";
import { HandleView, Resizer } from "@elysiax/flow";
import type { TargetModel } from "../../canvas.model";
import { useTargetLive } from "../infra/live";
import { DomainLink, StateDot, StateDotRoot } from "./atoms";
import { persistTargetSize, removeTarget } from "./persist";

export const AppNodeView = (props: {
  id: string;
  data: { t: TargetModel };
  selected: boolean;
  width?: number;
  height?: number;
}) => {
  const t = () => props.data.t;
  const live = useTargetLive(t().id);
  return (
    <div
      class="group relative flex h-full w-full flex-col overflow-hidden rounded-md border border-harbor-800 bg-harbor-950 transition-colors cursor-pointer hover:border-harbor-600"
      title="点击查看部署详情"
    >
      <Resizer
        nodeId={props.id}
        visible={props.selected}
        minW={320}
        minH={56}
        width={props.width ?? 320}
        height={props.height ?? 56}
        onEnd={(w, h) => persistTargetSize(t().id, w, h)}
      />
      <HandleView
        type="target"
        id={`tgt-${t().id}`}
        title="从数据库卡拖线到这里 = app 依赖"
      />
      {/* 顶部一行：状态点 + 项目名 + 右上角关闭 */}
      <div class="flex h-9 shrink-0 items-center gap-1.5 border-b border-harbor-800/60 px-2.5">
        <StateDotRoot targetId={t().id} />
        <span class="truncate text-xs font-medium text-neutral-100">
          📦 {t().name}
        </span>
        <Show when={live().running}>
          <span class="mono shrink-0 text-[10px] text-neutral-600">
            部署中…
          </span>
        </Show>
        <button
          class="nodrag ml-auto -mr-1 hidden rounded p-0.5 text-neutral-600 hover:text-signal-500 group-hover:block"
          aria-label="移除部署目标"
          onClick={(e) => {
            e.stopPropagation();
            removeTarget(t());
          }}
        >
          ✕
        </button>
      </div>
      {/* 服务列表：纯流式行（服务名 + 该服务绑定的域名），无边框子节点 */}
      <div class="flex min-h-0 flex-1 flex-col gap-1 px-2.5 py-1.5">
        <For each={t().services}>
          {(s) => (
            <div class="flex flex-col gap-0.5">
              <div class="flex items-center gap-1.5">
                <StateDot targetId={t().id} svcName={s.name} />
                <span class="mono truncate text-[11px] text-neutral-200">
                  {s.name}
                </span>
                <Show when={s.port}>
                  <span class="mono shrink-0 text-[11px] text-neutral-600">
                    :{s.port}
                  </span>
                </Show>
              </div>
              <For each={s.domains}>{(d) => <DomainLink d={d} />}</For>
            </div>
          )}
        </For>
        {/* app 级域名（无 serviceName 归属） */}
        <For each={t().domains}>{(d) => <DomainLink d={d} />}</For>
        <Show when={t().services.length === 0 && t().domains.length === 0}>
          <span class="text-[11px] text-neutral-600">无服务</span>
        </Show>
      </div>
    </div>
  );
};
