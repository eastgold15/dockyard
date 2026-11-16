/** @jsxImportSource solid-js */
/** 服务卡（compose 声明式识别的叶子单元）：无边框纯内容行，嵌在 app 卡内——
 *  消除「父框套子框」的多层边框嵌套，app 卡就是唯一的长方体 */
import { For, Show } from "solid-js";
import { HandleView } from "@elysiax/flow";
import type { ServiceRow, TargetModel } from "../../canvas.model";
import { DomainLink, StateDot } from "./atoms";

export const ServiceNodeView = (props: {
  data: { t: TargetModel; s: ServiceRow };
}) => (
  <div
    class="flex h-full w-full cursor-pointer flex-col justify-center px-2 py-0.5 transition-colors hover:bg-harbor-800/40"
    title="点击查看服务详情"
  >
    <HandleView
      type="target"
      id={`tgt-${props.data.t.id}-${props.data.s.name}`}
      title="从数据库卡拖线到这里 = 该服务依赖"
    />
    <div class="flex items-center gap-1.5">
      <StateDot targetId={props.data.t.id} svcName={props.data.s.name} />
      <span class="mono truncate text-[11px] text-neutral-200">
        {props.data.s.name}
      </span>
      <Show when={props.data.s.port}>
        <span class="mono shrink-0 text-[11px] text-neutral-600">
          :{props.data.s.port}
        </span>
      </Show>
    </div>
    <For each={props.data.s.domains}>{(d) => <DomainLink d={d} />}</For>
  </div>
);
