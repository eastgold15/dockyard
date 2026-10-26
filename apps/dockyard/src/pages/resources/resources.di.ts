import { defineModule, provide } from "@elysiax/core";
import { ServerService } from "../servers/servers.socket";
import { ResourceRepository } from "./resources.repository";
import { ResourceService } from "./resources.service";

export default defineModule({
  route: "/resources",
  provides: {
    resourceRepository: provide(ResourceRepository, ["db"]),
    resourceService: provide(ResourceService, [ResourceRepository, ServerService]),
  },
});
