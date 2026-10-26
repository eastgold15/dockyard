import { defineModule, provide } from "@elysiax/core";
import { GithubService } from "./github.service";

export default defineModule({
  route: "/github",
  provides: {
    githubService: provide(GithubService),
  },
});
