/** @jsxImportSource @solidjs/web */
/** 服务器卡（父）：只有标题；内容由子卡（app/db）撑大，尺寸在 board 同步时按子卡 bounds 算 */
import { Resizer } from "@elysiax/flow";
import type { CardModel } from "../../canvas.model";
import { Badge } from "./atoms";
import { persistServerSize } from "./persist";

export const ServerNodeView = (props: {
  id: string;
  data: { server: CardModel["server"] };
  selected: boolean;
  width?: number;
  height?: number;
}) => {
  const server = () => props.data.server;
  return (
    <div class="flex h-full w-full flex-col rounded-lg border border-harbor-600 bg-harbor-900/80 shadow-xl">
      <Resizer
        nodeId={props.id}
        visible={props.selected}
        minW={320}
        minH={160}
        width={props.width ?? 320}
        height={props.height ?? 160}
        onEnd={(w, h) => persistServerSize(server().id, w, h)}
      />
      <div class="flex cursor-move items-center justify-between rounded-t-lg border-b border-harbor-700 bg-harbor-800/80 px-3 py-1.5 select-none">
        <span class="text-sm font-medium text-neutral-100">
          🖥 {server().name}
        </span>
        {server().dockerStatus === "ok" ? (
          <Badge tone="ok">docker {server().dockerVersion ?? ""}</Badge>
        ) : server().dockerStatus === "missing" ? (
          <Badge tone="err">无 docker</Badge>
        ) : (
          <Badge tone="muted">未检测</Badge>
        )}
      </div>
      <div class="mono px-3 py-1 text-[11px] text-neutral-600">
        {server().local
          ? "本地进程直连"
          : `${server().user}@${server().host}:${server().port}`}
      </div>
    </div>
  );
};
