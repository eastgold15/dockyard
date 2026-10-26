/** client 的 API 层：Eden Treaty 端到端类型客户端（路径/params/body/query 全类型安全）。
 *  端点分流：部署语境在 /api/deploy/*（api），画布原生在 /api/canvas/*（canvasApi）。
 *  浏览器原生场景（href 下载、EventSource SSE、裸文本流）Eden 管不到，
 *  仍用 routes.gen 的 URL 助手（deployPaths / canvasPaths）。 */
import { treaty } from "@elysia/eden";
import { routes } from "../../../../.elysiax/routes.gen";
import type { DeployApi } from "../../deploy/deploy.socket";
import type { CanvasApi } from "../canvas.socket";

export const api = treaty<DeployApi>(`${location.origin}/api/deploy`);
export const canvasApi = treaty<CanvasApi>(`${location.origin}/api/canvas`);

export const deployPaths = routes.pages.deploy;
export const canvasPaths = routes.pages.canvas;

/** Eden TreatyResponse 的宽松形状（data 按状态码收窄，这里只取成功分支） */
type AnyTreaty = {
  data: unknown;
  // 端点未声明错误状态码时 Eden 推断为 { status: unknown; value: unknown }
  error: { status: unknown; value: unknown } | null;
};

/** 从错误体提取消息：ServiceError 映射是 { error } JSON，校验错误是 422 对象，兜底原文 */
function errMessage(value: unknown): string | null {
  if (value && typeof value === "object") {
    const v = value as { error?: unknown; message?: unknown };
    if (typeof v.error === "string") return v.error;
    if (typeof v.message === "string") return v.message;
  }
  return typeof value === "string" ? value : null;
}

/** Eden 的 { data, error } → 抛错式（沿用旧助手语义：失败抛 Error(message)） */
export async function unwrap<R extends AnyTreaty>(
  p: Promise<R>,
): Promise<NonNullable<R["data"]>> {
  const { data, error } = await p;
  if (error) throw new Error(errMessage(error.value) ?? `HTTP ${String(error.status)}`);
  return data as NonNullable<R["data"]>;
}
