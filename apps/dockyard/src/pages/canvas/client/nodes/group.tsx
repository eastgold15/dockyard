/** @jsxImportSource @solidjs/web */
/** 服务分组（服务器卡内的命名容器）：虚线边界 + 标题；app/db 卡可拖入 */
import { Resizer } from "@elysiax/flow";
import type { GroupModel } from "../../canvas.model";
import { persistGroupSize } from "./persist";

export const GroupNodeView = (props: {
  id: string;
  data: { g: GroupModel };
  selected: boolean;
  width?: number;
  height?: number;
}) => (
  <div class="flex h-full w-full flex-col rounded-md border border-dashed border-harbor-500/70 bg-harbor-800/30">
    <Resizer
      nodeId={props.id}
      visible={props.selected}
      minW={220}
      minH={120}
      width={props.width ?? 220}
      height={props.height ?? 120}
      onEnd={(w, h) => persistGroupSize(props.data.g.id, w, h)}
    />
    <div class="cursor-move px-2.5 py-1 text-[11px] font-medium tracking-wide text-neutral-400 uppercase select-none">
      ▸ {props.data.g.name}
    </div>
  </div>
);
