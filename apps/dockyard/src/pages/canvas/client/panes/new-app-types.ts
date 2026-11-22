/** @jsxImportSource @solidjs/web */
/**
 * 画布抽屉/弹窗（Solid 版）：数据走 /api/canvas JSON，
 * 写操作 JSON 进出，错误内联回显；结构变更后 emitRefresh() 让画布重拉。
 *
 * React → Solid 转换要点：
 * - useState → createSignal，读取一律函数调用（envText() 等）
 * - useEffect → onSettled（一次性加载/轮询）/ createEffect（跟随信号重拉）
 * - 行内编辑列表用 <For keyed={false}>：patchSvc 换对象引用时保 DOM，输入框不丢焦点
 * - React 版靠 key={repoUrl} 重挂载换 defaultValue，Solid 改为信号量受控输入
 * - onChange → 文本/数字用 onInput，select/checkbox/radio 用 onChange（原生语义）
 */
import {
  createEffect,
  createSignal,
  For,
  Match,
  onSettled,
  Show,
  Switch,
} from "solid-js";;;
import type { JSX } from "@solidjs/web";
import type {
  Deployment,
  DeploymentRow,
  DeployTarget,
} from "@/pages/deploy/deploy.socket";
import type { Domain } from "@/pages/edge/edge.socket";
import type { RepoBrief } from "@/pages/github/github.socket";
import type { DbConnection, DbRef, EnvEntry } from "@/pages/deploy/deploy.socket";
import type { DetectResult, DetectedService } from "@/pages/deploy/deploy.socket";
import type { DiscoveredContainer } from "../../canvas.model";
import copy from "copy-to-clipboard";
// env 文本函数从零依赖模块引（detect.ts 依赖链里的 dotenv 无法进浏览器包）
import { envMapToText, serviceEnvToText, textToEnvMap } from "@/shared/env-text";
import { api, deployPaths, unwrap } from "../infra/api";
import { ConsoleView } from "./console";
import { LogView } from "./log-view";
import { emitRefresh, useUi } from "../infra/ui";
import { confirmAction, toast } from "@/shared/solid-ui/feedback";
import { useDeployLog, useTargetLive } from "../infra/live";
import {
  mergeLiveRow,
  PipelineSteps,
  stagePosture,
  stepStates,
} from "./pipeline-steps";
// 移除目标的行为与卡面 ✕ 共用一份（成功才关抽屉，取消/失败保持原状）
import { removeTarget } from "../nodes";
// Panda recipe（panda/recipes.ts）：与 htmx 侧共享同一视觉契约，运行时只产 className
import {
  badge,
  button,
  drawer,
  field,
  modal,
} from "../../../../../styled-system/recipes";
import { cx } from "../../../../../styled-system/css";


import { Chip, Drawer, ErrorBanner, Field, Modal, Notice, Section, SubmitBtn } from "./shell";
// ── 共享类型（与 canvas.actions 的 JSON 响应对齐）──

export interface Carry {
  nodeId: number;
  projectId?: number | null;
  name: string;
  repoUrl?: string;
  branch: string;
  remoteDir: string;
}
export interface SharedMatch {
  service: string;
  name: string;
  dbType: string;
  envKey: string;
  url: string;
  displayUrl: string;
  /** 共享资源 id（变量绑定的来源标识） */
  resourceId: number;
}
export interface DetectStepData {
  carry: Carry;
  detect: DetectResult;
  envText: string;
  dbRefs: DbRef[];
  sharedMatches: SharedMatch[];
}
export type NewAppData =
  | {
      mode: "github";
      repos: RepoBrief[];
      reposStale?: boolean;
      prefillRepo?: string;
    }
