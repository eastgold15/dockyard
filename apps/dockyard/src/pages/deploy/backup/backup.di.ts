import { defineModule, provide } from "@elysiax/core";
import { CanvasService } from "../../canvas/canvas.socket";
import { ServerService } from "../../servers/servers.socket";
import { DeployService } from "../deploy.socket";
import { BackupService } from "./backup.service";

// 嵌套原子：备份属于 deploy 的功能组成，但保持独立人格（自己的 di/socket）
export default defineModule({
  provides: {
    backupService: provide(BackupService, [DeployService, CanvasService, ServerService, "appPaths"]),
  },
});
