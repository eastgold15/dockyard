import { defineModule, provide } from "@elysiax/core";
import { LocalService } from "./local.service";
import { ProjectRepository } from "./projects.repository";
import { ProjectService } from "./projects.service";

export default defineModule({
  route: "/projects",
  provides: {
    // 值服务（db）没有类，用字符串键；类服务写类引用，编译期校验
    projectRepository: provide(ProjectRepository, ["db"]),
    projectService: provide(ProjectService, [ProjectRepository]),
    localService: provide(LocalService),
  },
});
