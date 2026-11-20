import { defineModule, provide } from "@elysiax/core";
import { UpdatePoller } from "@/pages/deploy/deploy.socket";
import { GithubRepository } from "./github.repository";
import { GithubService } from "./github.service";
import { GithubPushService } from "./push.service";

export default defineModule({
  route: "/github",
  provides: {
    githubRepository: provide(GithubRepository, ["db"]),
    // 凭据来源：GitHub App（优先）/ gh CLI 回落，服务内部自己判
    githubService: provide(GithubService, [GithubRepository]),
    // push webhook 的跨原子触发点（中间者）：唯一被允许碰 updatePoller 的入口。
    // 服务键级图上 githubPushService → updatePoller → githubService 是一条链，不是环。
    githubPushService: provide(GithubPushService, [UpdatePoller]),
  },
});
