import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// ── 项目空间 ──
export const projects = sqliteTable("projects", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  slug: text().notNull().unique(),
  // 项目 = 仓库：绑定的 GitHub 仓库（可空——允许纯数据库编排的项目空间）
  repoUrl: text(),
  // 本地仓库路径（扫描发现/点击落库）；与 repoUrl 可并存——本地目录的 origin 就是那个仓库
  localPath: text(),
  // Openship 导入来源：github = 远端拉代码+服务器构建；local = 本地构建+镜像推送（null = 旧数据，按 localPath/repoUrl 推断）
  sourceType: text({ enum: ["github", "local"] }),
  // 默认分支与项目根目录（Source 配置；根目录是 monorepo 子目录场景）
  branch: text(),
  rootDir: text(),
  createdAt: integer({ mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type Project = typeof projects.$inferSelect;
