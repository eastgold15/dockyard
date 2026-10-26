// resources 原子的插座：服务器共享资源（中间件目录）。
// db 模板是"资源目录"概念（如何部署一类中间件），归本原子，deploy 经此插座引用。
export { serverResources } from "./schema";
export type { ServerResource } from "./schema";
export { ResourceService } from "./resources.service";
export type { SharedEnv } from "./resources.service";
export {
  DB_PORTS,
  LOGICAL_DB_SUPPORT,
  containerNameOf,
  dbCompose,
  generatePassword,
  instanceUrl,
  logicalDbCommands,
  logicalDbUrl,
  sharedContainerNameOf,
  suggestedEnvKey,
} from "./db-templates";
export type { DbType } from "./db-templates";
