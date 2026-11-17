import { defineModule, provide } from "@elysiax/core";
import { GithubRepository } from "./github.repository";
import { GithubService } from "./github.service";

export default defineModule({
  route: "/github",
  provides: {
    githubRepository: provide(GithubRepository, ["db"]),
    // 凭据来源：GitHub App（优先）/ gh CLI 回落，服务内部自己判
    githubService: provide(GithubService, [GithubRepository]),
  },
});
