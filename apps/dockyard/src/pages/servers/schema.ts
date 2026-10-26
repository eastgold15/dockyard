import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// ── 服务器：SSH 连接信息 + docker 状态 ──
export const servers = sqliteTable("servers", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  host: text().notNull(),
  port: integer().notNull().default(22),
  user: text().notNull(),
  // key = 私钥文件 | password | agent
  authType: text({ enum: ["key", "password", "agent"] }).notNull().default("key"),
  keyPath: text(), // authType=key 时的私钥路径
  password: text(), // authType=password 时（enc1: 加密）
  // unknown | ok | missing
  dockerStatus: text({ enum: ["unknown", "ok", "missing"] }).notNull().default("unknown"),
  dockerVersion: text(),
  // TOFU：首次连接确认后存储的主机密钥指纹
  hostKeyFingerprint: text(),
  // 机器指纹：防止同一台物理机被添加两次 / IP 漂移误部署
  machineId: text(), // /etc/machine-id
  dockerId: text(), // docker info 的 Server ID
  lastCheckedAt: integer({ mode: "timestamp" }),
  createdAt: integer({ mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type Server = typeof servers.$inferSelect;
