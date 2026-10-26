import { defineModule, provide } from "@elysiax/core";
import { ServerService } from "../servers/servers.socket";
import { EdgeRepository } from "./edge.repository";
import { EdgeService } from "./edge.service";

export default defineModule({
  route: "/edge",
  provides: {
    edgeRepository: provide(EdgeRepository, ["db"]),
    edgeService: provide(EdgeService, [EdgeRepository, ServerService]),
  },
});
