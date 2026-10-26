import { ServiceError } from "@elysiax/core";
/** 解析 GitHub 仓库为 owner/repo（https/ssh/短格式都接受）——deploy 与 projects 共用的纯函数 */
export function parseOwnerRepo(repoUrl: string): string {
  const m =
    repoUrl.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/) ??
    repoUrl.match(/^([^/\s]+\/[^/\s]+)$/);
  if (!m) throw new ServiceError(`无法解析 GitHub 仓库: ${repoUrl}`);
  return m[1]!;
}
