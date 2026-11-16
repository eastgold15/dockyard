import { eq } from "drizzle-orm";
import type { Db } from "../../shared/db";
import {
  canvasNodes,
  serviceGroups,
  type CanvasNode,
  type ServiceGroup,
} from "./schema";

export class CanvasRepository {
  constructor(private readonly db: Db) { }

  /** 世界地图：全部服务器卡（无项目边界） */
  async nodesAll() {
    return this.db.select().from(canvasNodes);
  }

  async byId(id: number) {
    return this.db
      .select()
      .from(canvasNodes)
      .where(eq(canvasNodes.id, id))
      .limit(1)
      .then((r) => r[0]);
  }

  async byServerId(serverId: number) {
    return this.db
      .select()
      .from(canvasNodes)
      .where(eq(canvasNodes.serverId, serverId))
      .limit(1)
      .then((r) => r[0]);
  }

  /** 幂等：serverId 全局唯一，已存在则返回已有行（忽略新坐标） */
  async add(serverId: number, x: number, y: number) {
    const existing = await this.byServerId(serverId);
    if (existing) return existing;
    const [row] = await this.db
      .insert(canvasNodes)
      .values({ serverId, x, y })
      .returning();
    return row!;
  }

  /** 位置/尺寸持久化（拖拽、resize 结束调用） */
  async move(id: number, patch: Partial<Pick<CanvasNode, "x" | "y" | "w" | "h">>) {
    return this.db.update(canvasNodes).set(patch).where(eq(canvasNodes.id, id));
  }

  async remove(id: number) {
    return this.db.delete(canvasNodes).where(eq(canvasNodes.id, id));
  }

  // ── 服务分组（服务器卡内的命名容器）──
  async groupsOf(nodeId: number) {
    return this.db
      .select()
      .from(serviceGroups)
      .where(eq(serviceGroups.nodeId, nodeId))
      .orderBy(serviceGroups.id);
  }

  async addGroup(nodeId: number, name: string) {
    const [row] = await this.db
      .insert(serviceGroups)
      .values({ nodeId, name })
      .returning();
    return row!;
  }

  async updateGroup(
    id: number,
    patch: Partial<Pick<ServiceGroup, "name" | "x" | "y" | "w" | "h">>,
  ) {
    return this.db
      .update(serviceGroups)
      .set(patch)
      .where(eq(serviceGroups.id, id));
  }

  async removeGroup(id: number) {
    return this.db.delete(serviceGroups).where(eq(serviceGroups.id, id));
  }
}
