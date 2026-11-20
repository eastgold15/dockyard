import { ServiceError } from "@elysiax/core";
import type { ResourceService } from "@/pages/resources/resources.socket";
import type { ServerService } from "./servers.socket";
import type { ResourcesResponse } from "./servers.types";

/**
 * servers 页面的共享资源组合根（中间者）。
 *
 * 「服务器卡里的共享资源弹窗」要同时读资源行（resources 原子）与服务器行（本原子）：
 * 资源列表、连接串、以及弹窗顶部展示的服务器信息。组合放在这里，
 * actions 只认这一个键，不跨原子 di.get。
 *
 * 没有任何服务依赖它 → 服务键级图上的叶子，不构成 servers ↔ resources 的回边。
 */
export class ServerResourceService {
  constructor(
    private readonly resource: ResourceService,
    private readonly server: ServerService,
  ) { }

  /** 弹窗数据：服务器 + 该服务器上的资源（含连接串）。服务器不存在 = 404 */
  async model(serverId: number): Promise<ResourcesResponse> {
    const server = await this.server.byId(serverId);
    if (!server) throw new ServiceError(`服务器不存在: ${serverId}`);
    const resources = await this.resource.ofServer(serverId);
    const withUrl = await Promise.all(
      resources.map(async (r) => ({
        resource: r,
        url: await this.resource.urlOf(r.id),
      })),
    );
    return { server, resources: withUrl };
  }

  /** 新建共享资源：预期错误（重名/非法 envKey）由 ResourceService 抛 ServiceError */
  async create(
    input: Parameters<ResourceService["create"]>[0],
  ): Promise<ResourcesResponse> {
    await this.resource.create(input);
    return this.model(input.serverId);
  }

  /** 部署共享资源并回弹窗数据；不存在 = 404 */
  async deploy(id: number): Promise<ResourcesResponse> {
    const target = await this.resource.byId(id);
    if (!target) throw new ServiceError("共享资源不存在", 404);
    await this.resource.deploy(id);
    return this.model(target.serverId);
  }

  /** 删除共享资源并回弹窗数据；不存在 = 404 */
  async remove(id: number): Promise<ResourcesResponse> {
    const target = await this.resource.byId(id);
    if (!target) throw new ServiceError("共享资源不存在", 404);
    await this.resource.remove(id);
    return this.model(target.serverId);
  }
}
