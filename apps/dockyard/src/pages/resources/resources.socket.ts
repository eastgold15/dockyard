// resources 原子的插座：服务器共享资源（中间件目录）。
// db 模板是"资源目录"概念（如何部署一类中间件），归本原子，deploy 经此插座引用。
export { serverResources } from "./schema";
export type { ServerResource } from "./schema";
export { ResourceService } from "./resources.service";
export type { SharedEnv } from "./resources.service";
export {
  DB_PORTS,
  LOGICAL_DB_SUPPORT,
  assertSafeLogicalName,
  assertSafeResourceName,
  containerNameOf,
  dbConnectionUrl,
  dbCompose,
  dbProjectNameOf,
  dbTypeOfImage,
  generatePassword,
  instanceUrl,
  logicalDbCommands,
  logicalDbUrl,
  sharedContainerNameOf,
  sharedProjectNameOf,
  suggestedEnvKey,
} from "./db-templates";
export type { DbType } from "./db-templates";
// 镜像变量表（Railway 模型：部署数据库时声明该镜像要哪些变量，app 侧勾选注入）
export { IMAGE_VARS, derivedVars, providedVars } from "./db-vars";
export type { ImageVar, ProvidedVar } from "./db-vars";
