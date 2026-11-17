// github 原子的插座：凭据访问服务 + App 安装凭据表。
// 表（github_apps）只在本原子内用，不外泄——跨原子要走服务方法。
export { GithubService } from "./github.service";
export type { RepoBrief, AppStatus, AppInstall } from "./github.service";
export { GithubRepository } from "./github.repository";
export { parseOwnerRepo } from "./github";
