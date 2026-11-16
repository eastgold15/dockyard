/** @jsxImportSource solid-js */
/** 发现容器卡（只读）：服务器上 docker 里跑着、但不归 dockyard 管的容器。
 *  虚框 + 「发现」徽章，明确它与部署目标卡不同：没有部署/回滚/备份入口 */
import { Show } from "solid-js";
import type { DiscoveredContainer } from "../../canvas.model";
import { lens } from "../infra/lens";
import { Badge } from "./atoms";

export const ContainerNodeView = (props: {
  id: string;
  data: { d: DiscoveredContainer };
  selected: boolean;
  width?: number;
  height?: number;
}) => {
  const d = () => props.data.d;
  return (
    <div
      class="flex h-full w-full cursor-pointer flex-col justify-center gap-1 rounded-lg border border-dashed border-harbor-600 bg-harbor-950/70 px-3 py-2 transition-colors hover:border-harbor-500"
      title="点击查看容器详情（只读）"
    >
      <div class="flex items-center gap-2">
        <span
          class={`h-2 w-2 shrink-0 rounded-full ${d().state === "running" ? "bg-tide-400" : "bg-signal-500"}`}
        />
        <span
          class="truncate text-sm font-medium text-neutral-200"
          title={d().name}
        >
          {d().name}
        </span>
        <span class="ml-auto flex shrink-0 items-center gap-1">
          {/* 世界视图（无透镜）下标注项目归属，与部署目标卡一致 */}
          <Show when={lens() == null && d().projectName}>
            <Badge tone="muted">{d().projectName}</Badge>
          </Show>
          <Badge tone="muted">发现</Badge>
        </span>
      </div>
      <div class="mono truncate text-[11px] text-neutral-500" title={d().image}>
        {d().image}
      </div>
      <div class="mono flex items-center justify-between gap-2 text-[11px] text-neutral-600">
        <span class="truncate">
          {d().service || d().composeProject || "独立容器"}
        </span>
        <Show when={d().ports}>
          <span class="shrink-0">{d().ports}</span>
        </Show>
      </div>
    </div>
  );
};
