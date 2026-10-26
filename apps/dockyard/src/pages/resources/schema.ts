import { sqliteTable, text, integer, unique } from "drizzle-orm/sqlite-core";
// 插头：外键经插座引用（di 已声明依赖 servers）
import { servers } from "../servers/servers.socket";

// ── 服务器共享资源清单：绑定到单台服务器的中间件（视角 B 预部署产物）──
// 任意项目部署到该服务器时可引用其连接串（envKey 下拉），不再重复部署中间件
export const serverResources = sqliteTable("resources", {
  id: integer().primaryKey({ autoIncrement: true }),
  serverId: integer().notNull().references(() => servers.id, { onDelete: "cascade" }),
  name: text().notNull(),
  dbType: text({ enum: ["postgres", "mysql", "redis", "mongo"] }).notNull(),
  // 远端容器名（dockyard-res-<id>-<name>，对账/防抢用）
  containerName: text(),
  // 注入给业务 app 的环境变量键名（redis → REDIS_URL，其余 DATABASE_URL；可改）
  envKey: text().notNull(),
  // 连接凭据 {url, password}（enc1: 加密；永不进仓库）
  credsJson: text(),
  createdAt: integer({ mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  unique().on(t.serverId, t.name),
]);

export type ServerResource = typeof serverResources.$inferSelect;
