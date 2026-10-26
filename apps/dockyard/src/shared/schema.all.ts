/**
 * 仅构建期使用：drizzle-kit generate 需要看到全量 schema 图才能 diff 出 SQL。
 * 运行时代码禁止 import 本文件（各原子用自己的 ./schema，跨原子走插座）。
 */
export * from "../pages/servers/schema";
export * from "../pages/projects/schema";
export * from "../pages/canvas/schema";
export * from "../pages/deploy/schema";
export * from "../pages/resources/schema";
export * from "../pages/edge/schema";
