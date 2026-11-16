/** Solid 页面共享的 Eden Treaty 助手：把 { data, error } 收成抛错式，错误消息取自 { error }。 */

/** Eden TreatyResponse 的宽松形状（data 按状态码收窄，这里只取成功分支） */
export type AnyTreaty = {
  data: unknown;
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

/** Eden 的 { data, error } → 抛错式（失败抛 Error(message)） */
export async function unwrap<R extends AnyTreaty>(
  p: Promise<R>,
): Promise<NonNullable<R["data"]>> {
  const { data, error } = await p;
  if (error)
    throw new Error(errMessage(error.value) ?? `HTTP ${String(error.status)}`);
  return data as NonNullable<R["data"]>;
}
