import { sqliteTable, text, integer, unique } from "drizzle-orm/sqlite-core";
// 插头：外键经插座引用（di 已声明依赖 servers）
import { servers } from "../servers/servers.socket";

// ── 画布节点：世界地图上的一张服务器卡片（物理服务器全局唯一，不再以项目为边界）──
export const canvasNodes = sqliteTable("canvas_nodes", {
  id: integer().primaryKey({ autoIncrement: true }),
  serverId: integer().notNull().unique().references(() => servers.id, { onDelete: "cascade" }),
  x: integer().notNull().default(40),
  y: integer().notNull().default(40),
  w: integer().notNull().default(320),
  h: integer().notNull().default(240),
});

// ── 服务分组：画布上的命名分组容器，归属某张服务器卡 ──
export const serviceGroups = sqliteTable("canvas_groups", {
  id: integer().primaryKey({ autoIncrement: true }),
  nodeId: integer().notNull().references(() => canvasNodes.id, { onDelete: "cascade" }),
  name: text().notNull(),
  x: integer().notNull().default(24),
  y: integer().notNull().default(24),
  w: integer().notNull().default(360),
  h: integer().notNull().default(280),
}, (t) => [
  unique().on(t.nodeId, t.name),
]);

export type CanvasNode = typeof canvasNodes.$inferSelect;
export type ServiceGroup = typeof serviceGroups.$inferSelect;
