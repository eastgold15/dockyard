// deploy 原子的插座：部署目标/部署历史表 + 部署服务 + 事件总线 + 轮询器 + 自动识别。
// client（浏览器包）只允许 import type（值会打进浏览器包）。
export { deployTargets, deployments, deployArtifacts } from "./schema";
export type {
  DeployTarget,
  Deployment,
  DeployArtifact,
  DeployStage,
  TargetService,
  TargetServicesDoc,
  DepEdge,
} from "./schema";
export type { DeploymentRow } from "./deploy.repository";
export { DeployService, sourceTypeOf } from "./deploy.service";
export type { DbRef, DbConnection, EnvEntry } from "./deploy.service";
export { events, CANVAS_CHANNEL } from "./events";
export type { CanvasEvent } from "./events";
// 日志三源的公共类型（client 只取类型：log-stream.ts 不 import Node-only 包）
export type { LogSource, LogChunk } from "./log-stream";
// 多路复用帧头剥离（嵌套原子 runtime 也用得到——跨原子必须走插座）
export { decodeDockerFrames } from "./log-stream";
export { ContainerPoller } from "./container-poller";
export { UpdatePoller } from "./update-poller";
export {
  detectRepo,
  detectLocal,
  detectToEnvText,
  detectToOverrideCompose,
  guessDbType,
} from "./detect";
export type { DetectResult, DetectedService } from "./detect";

// Eden Treaty 的 API 类型出口：canvas client（跨原子）经插座引用，
// type-only 在浏览器打包时被擦除，不进 bundle
import type deployApi from "./deploy.actions";
export type DeployApi = typeof deployApi;
