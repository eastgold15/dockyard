/** 镜像源解析（零依赖）：client 也要用，不能从带 node:os/dockerode 的 service 值导入。 */
import type { Server } from "./schema";

/** DB 存的是 JSON 数组字符串；解析失败/空值一律当 [] 处理（存量行没有该列） */
export function parseMirrors(
  server: Pick<Server, "registryMirrors">,
): string[] {
  if (!server.registryMirrors) return [];
  try {
    const arr = JSON.parse(server.registryMirrors) as unknown;
    return Array.isArray(arr)
      ? arr.filter(
          (m): m is string => typeof m === "string" && m.trim().length > 0,
        )
      : [];
  } catch {
    return [];
  }
}
