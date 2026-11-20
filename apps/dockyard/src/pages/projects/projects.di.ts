import { defineModule, provide } from "@elysiax/core";
import { GithubService } from "../github/github.socket";
import { LocalService } from "./local.service";
import { ProjectRepository } from "./projects.repository";
import { ProjectService } from "./projects.service";

export default defineModule({
  route: "/projects",
  provides: {
    // 值服务（db）没有类，用字符串键；类服务写类引用，编译期校验
    projectRepository: provide(ProjectRepository, ["db"]),
    // 新建弹窗要列 GitHub 仓库：跨原子依赖写在这里，窄 ServiceMap 才会包含 githubService
    projectService: provide(ProjectService, [ProjectRepository, GithubService]),
    localService: provide(LocalService),
  },
});
