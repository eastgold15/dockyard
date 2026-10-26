import { sqliteTable, text, integer, unique, index } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
// 插头：外键经插座引用（di 已声明依赖 canvas/projects）
import { canvasNodes, serviceGroups } from "../canvas/canvas.socket";
import { projects } from "../projects/projects.socket";

// ── 部署目标：一张卡片上部署的 app 或数据库 ──
export const deployTargets = sqliteTable("deploy_targets", {
  id: integer().primaryKey({ autoIncrement: true }),
  nodeId: integer().notNull().references(() => canvasNodes.id, { onDelete: "cascade" }),
  // 项目归属（世界地图：画布不再有项目边界，归属下沉到 target；null = 未关联）
  projectId: integer().references(() => projects.id),
  // 所属服务分组（null = 不分组，直接挂在服务器卡上）
  groupId: integer().references((): AnySQLiteColumn => serviceGroups.id),
  kind: text({ enum: ["app", "db"] }).notNull(),
  name: text().notNull(),
  // db 两层模型：null = 独立实例（或 app）；非 null = 逻辑库，指向宿主实例 target
  instanceOf: integer().references((): AnySQLiteColumn => deployTargets.id),
  // 远端容器名（部署时定死 dockyard-<id>-<name>，对账用）
  containerName: text(),
  // app：GitHub 仓库
  repoUrl: text(),
  branch: text().default("main"),
  composePath: text().default("docker-compose.yml"),
  serviceName: text(),
  // db：官方镜像模板
  dbType: text({ enum: ["postgres", "mysql", "redis", "mongo"] }),
  // 远端部署目录
  remoteDir: text(),
  // 资源限制 override compose（识别出的 cpus/mem_limit，部署时 -f 叠加；无秘密故明文）
  overrideCompose: text(),
  // 环境变量（敏感值 enc1: 加密）
  envJson: text(),
  // app 依赖的 db target id 列表（画布连线 + 连接串引用的血缘；不做外键，删 db 仅断线）
  dependsOn: text({ mode: "json" }).$type<number[]>(),
  // compose 服务清单（创建时从 DetectedService 落库，存量惰性补全；无秘密值，明文 JSON）
  servicesJson: text({ mode: "json" }).$type<TargetServicesDoc>(),
  // 实际要 up 的服务子集（共享资源复用时过滤掉中间件；null = compose 全量）
  upServices: text({ mode: "json" }).$type<string[]>(),
  // 画布布局：本卡在服务器卡内的位置（null → 岛端自动错位摆放）
  x: integer(),
  y: integer(),
  // 手动拉伸的卡尺寸（null → 按子卡 bounds 自动收敛；有值时作下限，不会被自动收敛压小）
  w: integer(),
  h: integer(),
  // 服务卡位置（key = compose 服务名）
  serviceLayout: text({ mode: "json" }).$type<Record<string, { x: number; y: number }>>(),
  // 服务级依赖边（画布真相；dependsOn 是其派生的血缘，双写保持一致）
  depEdges: text({ mode: "json" }).$type<DepEdge[]>(),
  // 更新轮询状态
  lastKnownSha: text(),
  etag: text(),
  updateAvailable: integer({ mode: "boolean" }).notNull().default(false),
  // 部署策略：manual=不轮询 / notify=只置徽章（存量行为）/ auto=检测到新 sha 自动部署
  deployPolicy: text({ enum: ["manual", "notify", "auto"] }).notNull().default("notify"),
  // 构建目标架构（linux/amd64 等；null = 部署时按远端 uname -m 自动探测）
  buildPlatform: text(),
  // 构建产物是否已传输到远端（部署通道：跨界拖卡的前置条件；本地构建部署成功自动置位）
  artifactShipped: integer({ mode: "boolean" }).notNull().default(false),
  // 产物落在哪台服务器（镜像只 load 在当次目标上）：换服务器必须重传，否则远端 up 会
  // 去 pull 一个 registry 里不存在的本地镜像名。artifactShipped 的布尔升维（体检病-1）
  artifactServerId: integer(),
  createdAt: integer({ mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  // 防误操作：同一卡片上同类型同名目标唯一（重复建库在表单层就拦住）
  unique().on(t.nodeId, t.kind, t.name),
]);

// ── 部署历史 ──
export const deployments = sqliteTable("deploy_runs", {
  id: integer().primaryKey({ autoIncrement: true }),
  targetId: integer().notNull().references(() => deployTargets.id, { onDelete: "cascade" }),
  status: text({
    enum: ["queued", "building", "transferring", "deploying", "success", "failed"],
  }).notNull().default("queued"),
  commitSha: text(),
  // 旧日志列：已停止写入（日志走 deploy_log_chunks），保留仅为读存量数据兜底
  logText: text().notNull().default(""),
  // 触发来源（回滚血缘：rollbackOf 指向被回滚的 run；ship = 仅传输产物不起容器）
  trigger: text({ enum: ["ui", "auto", "rollback", "ship"] }).notNull().default("ui"),
  rollbackOf: integer(),
  // 旧产物列：已停止写入（产物走 deploy_artifacts + artifactId），保留仅为存量兜底读
  imageSnapshot: text({ mode: "json" }).$type<Record<string, string>>(),
  // 旧产物列：同上（当次 compose/override/env 快照，enc1: 加密）
  snapshotJson: text(),
  // compose 项目名快照（回滚 up -p 必须与当初一致，否则会起第二套容器）
  project: text(),
  // 本次部署产出的产物（六阶段模型：Artifact 是一等实体，回滚 = 新 run 引用旧产物重新激活）
  artifactId: integer(),
  // 流水线当前阶段（执行序六段，见 DeployStage）。best-effort 进度指示，不是状态机：
  // success/failed 时驻留在最后到达段（failed 的断点=步骤条红叉）；null = 旁路（逻辑库）/存量降级。
  // 故意不加 enum（CHECK 约束改一次就要重建表）——取值域由 TS 层 DeployStage 约束
  stage: text().$type<DeployStage>(),
  startedAt: integer({ mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  finishedAt: integer({ mode: "timestamp" }),
});

// ── 部署产物（六阶段流水线的零界点：前半段自由组合，后半段由产物形态唯一决定）──
// 回滚 = 新 run 引用旧产物重新激活；同一产物可被多次激活。
// runId 是产出溯源（不设外键——run 会被 pruneRuns 清理，产物只要仍被引用就存活）。
export const deployArtifacts = sqliteTable("deploy_artifacts", {
  id: integer().primaryKey({ autoIncrement: true }),
  targetId: integer().notNull().references(() => deployTargets.id, { onDelete: "cascade" }),
  // 产出本产物的 run（溯源用；无 FK——产物寿命独立于产出它的 run）
  runId: integer().notNull(),
  // 产物形态（零界点扩展位：将来 fileTree/binary 等；本轮只有 compose 镜像集）
  kind: text({ enum: ["compose"] }).notNull().default("compose"),
  // compose 项目名（回滚 up -p 必须与当初一致，否则会起第二套容器）
  project: text(),
  // 镜像 pin 快照（service → dockyard-<targetId>-<svc>:run-<runId>），明文无秘密；空 = 不可 pin 回滚
  imageTags: text({ mode: "json" }).$type<Record<string, string>>(),
  // 当次 compose/override/env 快照（含秘密值，enc1: 加密；回滚时解密重建远端目录）
  snapshotJson: text().notNull(),
  // 源码版本（github sha / local 短 sha；回滚后回写 lastKnownSha）
  sha: text(),
  createdAt: integer({ mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ── 部署日志分块（替代 logText 读改写；每次 log 调用一条 chunk）──
export const deployLogChunks = sqliteTable("deploy_log_chunks", {
  id: integer().primaryKey({ autoIncrement: true }),
  runId: integer().notNull().references(() => deployments.id, { onDelete: "cascade" }),
  /** run 内单调递增（pipeline 生命周期独占写，内存计数器即可） */
  seq: integer().notNull(),
  text: text().notNull(),
  /** 块时间戳（毫秒） */
  ts: integer().notNull(),
}, (t) => [
  index("idx_deploy_log_chunks_run").on(t.runId, t.seq),
]);

/** compose 单个服务（画布小卡片行）。env/秘密值不进这里——走 envJson/overrideCompose 加密通道 */
export interface TargetService {
  name: string;
  port?: number;  // 对外发布端口（compose config 的 ports[0].published）
  image?: string; // 惰性补全从 compose config 取；创建路径没有则缺省
}
/** servicesJson 列的文档结构：project = compose 项目名（容器标签对账用，规则同部署端 cfg.name ?? dockyard-<id>） */
export interface TargetServicesDoc {
  project?: string;
  services: TargetService[];
}
/** 服务级依赖边：service=null 表示 app 整体依赖（旧 dependsOn 数据的等价形态） */
export interface DepEdge {
  service: string | null;
  db: number; // db target id
}

/** 六阶段流水线的阶段名（执行序：源→构建→传输→运行→暴露→产物） */
export type DeployStage =
  | "sourcing"
  | "building"
  | "transferring"
  | "deploying"
  | "exposing"
  | "packaging";

export type DeployTarget = typeof deployTargets.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type DeployArtifact = typeof deployArtifacts.$inferSelect;
