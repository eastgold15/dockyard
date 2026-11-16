/** @jsxImportSource solid-js */
/** 节点尺寸持久化与目标移除：Resizer/卡面 ✕ 共用同一套写操作。 */
import { api, canvasApi, unwrap } from "../infra/api";
import { emitRefresh } from "../infra/ui";
import { confirmAction, toast } from "../../../../shared/solid-ui/feedback";

/** Resizer 拉伸结束 → 持久化手动尺寸（refetch 后作自动收敛的下限）。
 *  服务端会按车道规则拒绝（422，例如本机卡拉宽压到中立带）：不能静默吞掉——
 *  提示原因并重拉 /board，把本地刚拉的尺寸回弹到库值。 */
const persistSize = (p: Promise<unknown>) =>
  void p.catch((e) => {
    toast((e as Error).message, "err");
    emitRefresh();
  });

export const persistServerSize = (nodeId: number, w: number, h: number) =>
  persistSize(
    unwrap(
      canvasApi
        .nodes({ id: nodeId })
        .patch({ w: Math.round(w), h: Math.round(h) }),
    ),
  );

export const persistGroupSize = (groupId: number, w: number, h: number) =>
  persistSize(
    unwrap(
      canvasApi
        .groups({ id: groupId })
        .patch({ w: Math.round(w), h: Math.round(h) }),
    ),
  );

export const persistTargetSize = (targetId: number, w: number, h: number) =>
  persistSize(
    unwrap(
      api
        .targets({ id: targetId })
        .layout.patch({ w: Math.round(w), h: Math.round(h) }),
    ),
  );

/** 移除部署目标（卡面 ✕ 与抽屉危险区共用）：确认 → 删除 → 刷新画布。
 *  返回是否真的删除，调用方据此决定是否关闭抽屉（取消/失败时保持原状）。 */
export async function removeTarget(t: {
  id: number;
  name: string;
  logical?: boolean | null;
}): Promise<boolean> {
  const ok = await confirmAction({
    title: t.logical
      ? `移除逻辑库「${t.name}」？`
      : `移除部署目标「${t.name}」？`,
    body: t.logical ? "远端数据库保留，不会 DROP。" : "远端容器不动。",
    confirmLabel: "移除",
    danger: true,
  });
  if (!ok) return false;
  try {
    await unwrap(api.targets({ id: t.id }).delete());
  } catch (e) {
    // 例如：实例下还有逻辑库，被阻止（409 + 错误文本）
    toast((e as Error).message, "err");
    return false;
  }
  emitRefresh();
  return true;
}
