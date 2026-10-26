import { ServiceError } from "@elysiax/core";
import type { CanvasRepository } from "./canvas.repository";

export class CanvasService {
  constructor(private readonly repo: CanvasRepository) {}

  nodesAll() {
    return this.repo.nodesAll();
  }

  byId(id: number) {
    return this.repo.byId(id);
  }

  /** 幂等：同 serverId 已上画则返回已有卡，不新建 */
  addNode(serverId: number, x = 40, y = 40) {
    return this.repo.add(serverId, x, y);
  }

  moveNode(id: number, patch: { x?: number; y?: number; w?: number; h?: number }) {
    return this.repo.move(id, patch);
  }

  removeNode(id: number) {
    return this.repo.remove(id);
  }

  // ── 服务分组 ──
  groupsOf(nodeId: number) {
    return this.repo.groupsOf(nodeId);
  }

  addGroup(nodeId: number, name: string) {
    if (!name.trim()) throw new ServiceError("分组名不能为空");
    return this.repo.addGroup(nodeId, name.trim());
  }

  updateGroup(id: number, patch: { name?: string; x?: number; y?: number; w?: number; h?: number }) {
    return this.repo.updateGroup(id, patch);
  }

  removeGroup(id: number) {
    return this.repo.removeGroup(id);
  }
}
