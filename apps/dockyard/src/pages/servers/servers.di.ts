import { defineModule, provide } from "@elysiax/core";
import { DockerRelay } from "./docker-relay";
import { ServerRepository } from "./servers.repository";
import { ServerService } from "./servers.service";
import { SshPool } from "./ssh-pool";

export default defineModule({
  route: "/servers",
  provides: {
    sshPool: provide(SshPool),
    dockerRelay: provide(DockerRelay),
    serverRepository: provide(ServerRepository, ["db"]),
    serverService: provide(ServerService, [ServerRepository, SshPool, DockerRelay]),
  },
});
