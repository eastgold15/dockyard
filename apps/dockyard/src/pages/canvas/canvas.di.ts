import { defineModule, provide } from "@elysiax/core";
import { ContainerPoller, DeployService } from "@/pages/deploy/deploy.socket";
import { EdgeService } from "@/pages/edge/edge.socket";
import { ProjectService } from "@/pages/projects/projects.socket";
import { ServerService } from "@/pages/servers/servers.socket";
import { BoardService } from "./board.service";
import { CanvasRepository } from "./canvas.repository";
import { CanvasService } from "./canvas.service";

export default defineModule({
  route: "/canvas",
  provides: {
    canvasRepository: provide(CanvasRepository, ["db"]),
    canvasService: provide(CanvasService, [CanvasRepository]),
    // canvas 页面的组合根（中间者）：依赖各原子的服务，自己不被任何服务依赖。
    // 服务键级图上 canvasBoardService → deployService → canvasService 是一条链，不是环。
    boardService: provide(BoardService, [
      CanvasService,
      DeployService,
      ServerService,
      ProjectService,
      EdgeService,
      ContainerPoller,
    ]),
  },
});
