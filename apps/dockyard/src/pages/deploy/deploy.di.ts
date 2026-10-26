import { defineModule, provide } from "@elysiax/core";
import { CanvasService } from "../canvas/canvas.socket";
import { GithubService } from "../github/github.socket";
import { ServerService } from "../servers/servers.socket";
import { EdgeService } from "../edge/edge.socket";
import { ProjectService } from "../projects/projects.socket";
import { ResourceService } from "../resources/resources.socket";
import { DeployRepository } from "./deploy.repository";
import { DeployService } from "./deploy.service";
import { ContainerPoller } from "./container-poller";
import { UpdatePoller } from "./update-poller";

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
  },
});
