import { defineModule, provide } from "@elysiax/core";
import { CanvasRepository } from "./canvas.repository";
import { CanvasService } from "./canvas.service";

export default defineModule({
  route: "/canvas",
  provides: {
    canvasRepository: provide(CanvasRepository, ["db"]),
    canvasService: provide(CanvasService, [CanvasRepository]),
  },
});
