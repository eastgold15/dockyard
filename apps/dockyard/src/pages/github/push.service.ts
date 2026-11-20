import type { UpdatePoller } from "@/pages/deploy/deploy.socket";

/**
 * github 页面的推送触发布局（中间者）。
 *
 * webhook 收到 push 后要触发部署侧的更新检查：github 原子不自己持有 updatePoller
 * （那会让 deploy 的轮询器反向变成 github 的依赖），改由本服务做这一个跨原子调用。
 *
 * 没有任何服务依赖它 → 服务键级图上的叶子。
 * 注意 updatePoller 自身依赖 githubService，但 githubService 不依赖本服务，
 * 所以 `githubPushService → updatePoller → githubService` 是一条链，不是环。
 */
export class GithubPushService {
  constructor(private readonly poller: UpdatePoller) { }

  /** push 到某个仓库：立刻检查该仓库的更新（不等下轮轮询） */
  checkRepo(fullName: string): Promise<void> {
    return this.poller.checkRepo(fullName);
  }
}
