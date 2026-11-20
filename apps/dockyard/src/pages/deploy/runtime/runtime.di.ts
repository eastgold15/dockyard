import { defineModule, provide } from "@elysiax/core";
import { CanvasService } from "@/pages/canvas/canvas.socket";
import { ServerService } from "@/pages/servers/servers.socket";
import { DeployService } from "@/pages/deploy/deploy.socket";
import { RuntimeService } from "./runtime.service";

// 嵌套原子：住在 deploy 肚子里（归属），但依赖声明与插座规则与平铺原子一致
export default defineModule({
  provides: {
    runtimeService: provide(RuntimeService, [
      DeployService,
      CanvasService,
      ServerService,
    ]),
  },
});
