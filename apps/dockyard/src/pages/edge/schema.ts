import { sqliteTable, text, integer, unique } from "drizzle-orm/sqlite-core";
// 插头：外键经插座引用（edge 依赖 deploy 的部署目标）
import { deployTargets } from "../deploy/deploy.socket";

// ── 域名绑定：app target 的自定义域名（edge 反代 + 自动证书的状态机）──
export const domains = sqliteTable("edge_domains", {
  id: integer().primaryKey({ autoIncrement: true }),
  targetId: integer().notNull().references(() => deployTargets.id, { onDelete: "cascade" }),
  hostname: text().notNull(),
  // 反代目标：compose 服务名 + 端口（多服务 app 靠它区分 api/admin/www）
  serviceName: text(),
  targetPort: integer().notNull(),
  // DNS 解析状态：unknown | ok（指向本机） | mismatch（解析到别处）
  dnsStatus: text({ enum: ["unknown", "ok", "mismatch"] }).notNull().default("unknown"),
  // 证书状态：none | pending（签发中） | active | error
  sslStatus: text({ enum: ["none", "pending", "active", "error"] }).notNull().default("none"),
  sslError: text(),
  createdAt: integer({ mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  // 同一 target 下域名唯一；跨 target 重复在 service 层拦（抢别人的域名是大事故）
  unique().on(t.targetId, t.hostname),
]);

export type Domain = typeof domains.$inferSelect;
