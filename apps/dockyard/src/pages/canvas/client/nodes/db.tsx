/** @jsxImportSource @solidjs/web */
/** 数据库卡（托管实例/逻辑库，直属服务器卡）：干净长方体，点击打开 Sidebar */
import {
  Show,
} from "solid-js";
import { HandleView, Resizer } from "@elysiax/flow";
import type { TargetModel } from "../../canvas.model";
import { useTargetLive } from "../infra/live";
import { StateDotRoot } from "./atoms";
import { persistTargetSize, removeTarget } from "./persist";

export const DbNodeView = (props: {
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
      class="group relative flex h-full w-full flex-col justify-center gap-1 rounded-md border border-harbor-800 bg-harbor-950 px-2.5 py-1.5 transition-colors cursor-pointer hover:border-harbor-600"
      title="点击查看部署详情"
    >
      <Resizer
        nodeId={props.id}
        visible={props.selected}
        minW={320}
        minH={72}
        width={props.width ?? 320}
        height={props.height ?? 72}
        onEnd={(w, h) => persistTargetSize(t().id, w, h)}
      />
      <HandleView
        type="source"
        id={`src-${t().id}`}
        title="从此圆点拖线到服务卡/app 卡建依赖"
      />
      <div class="flex items-center gap-1.5">
        <StateDotRoot targetId={t().id} />
        <span class="truncate text-xs font-medium text-neutral-100">
          {t().logical ? "⛁" : "🗄"} {t().name}
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
      <div class="flex items-center gap-1.5">
        <Show when={t().url}>
          <span class="mono truncate text-[11px] text-tide-400" title={t().url!}>
            {t().url!.replace(/^.+?:\/\/|\/.+$/g, "")}
          </span>
        </Show>
        <span class="mono text-[11px] text-neutral-600">
          {t().logical ? "逻辑库" : "实例"}
        </span>
      </div>
    </div>
  );
};
