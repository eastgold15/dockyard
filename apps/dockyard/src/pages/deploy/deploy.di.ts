import { defineModule, provide } from "@elysiax/core";
import { CanvasService } from "@/pages/canvas/canvas.socket";
import { GithubService } from "@/pages/github/github.socket";
import { ServerService } from "@/pages/servers/servers.socket";
import { EdgeService } from "@/pages/edge/edge.socket";
import { ProjectService } from "@/pages/projects/projects.socket";
import { ResourceService } from "@/pages/resources/resources.socket";
import { DeployRepository } from "./deploy.repository";
import { DeployService } from "./deploy.service";
import { ContainerPoller } from "./container-poller";
import { UpdatePoller } from "./update-poller";
import { DeployConsoleService } from "./console.service";
import { RuntimeService } from "./runtime/runtime.socket";
import { BackupService } from "./backup/backup.socket";

export default defineModule({
  provides: {
    deployRepository: provide(DeployRepository, ["db"]),
    deployService: provide(DeployService, [
      DeployRepository,
      ServerService,
      GithubService,
      CanvasService,
      "appPaths",
      EdgeService,
      ProjectService,
      ResourceService,
    ]),
    // 后台轮询器入 DI：依赖全部容器装配，index.ts 从根容器取出后 start()
    containerPoller: provide(ContainerPoller, [ServerService, "db"]),
    updatePoller: provide(UpdatePoller, [GithubService, "db", DeployService]),
    // 控制台组合根（中间者）：runtime/backup 两个嵌套原子的能力只经它进入本原子的 actions。
    // 服务键级图上 deployConsoleService → runtimeService → deployService 是一条链，不是环。
    deployConsoleService: provide(DeployConsoleService, [
      RuntimeService,
      BackupService,
    ]),
  },
});
