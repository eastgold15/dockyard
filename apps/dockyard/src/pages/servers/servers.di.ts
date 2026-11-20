import { defineModule, provide } from "@elysiax/core";
import { ResourceService } from "@/pages/resources/resources.socket";
import { DockerRelay } from "./docker-relay";
import { ServerResourceService } from "./resource.service";
import { ServerRepository } from "./servers.repository";
import { ServerService } from "./servers.service";
import { SshPool } from "./ssh-pool";

export default defineModule({
  route: "/servers",
  provides: {
    sshPool: provide(SshPool),
    dockerRelay: provide(DockerRelay),
    serverRepository: provide(ServerRepository, ["db"]),
    serverService: provide(ServerService, [
      ServerRepository,
      SshPool,
      DockerRelay,
    ]),
    // 共享资源弹窗的组合根（中间者）：资源行 + 服务器行的唯一组合入口。
    // 服务键级图上 serverResourceService → resourceService → serverService 是一条链，不是环。
    serverResourceService: provide(ServerResourceService, [
      ResourceService,
      ServerService,
    ]),
  },
});
