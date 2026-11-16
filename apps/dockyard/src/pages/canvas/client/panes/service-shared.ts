/** service 区域共享类型与格式化：抽屉壳与各 tab 共用，避免跨文件重复定义。 */
import type {
  DbConnection,
  DbRef,
  DeployTarget,
  DeploymentRow,
} from "../../../deploy/deploy.socket";
import type { Domain } from "../../../edge/edge.socket";

export type ServiceTab =
  "deployments" | "variables" | "metrics" | "console" | "settings" | "backups";

export interface Metrics {
  state: string;
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  netRx: number;
  netTx: number;
}

export interface ServiceDrawerData {
  target: DeployTarget;
  /** 服务端判定的构建来源形态（与部署分派同口径；null 兼容旧响应） */
  sourceType?: "local" | "github";
  svc?: string;
  /** 后端回显的 tab（全量返回后仅作回显，前端不依赖其裁剪数据） */
  tab?: string;
  deployments?: DeploymentRow[];
  envText?: string;
  dbRefs?: DbRef[];
  /** 该服务是用户 compose 自带的数据库时，服务端给出的连接信息 */
  connections?: DbConnection[];
  sharedEnv?: {
    resourceId: number;
    name: string;
    dbType: string;
    envKey: string;
    url: string;
  }[];
  selectedDeps?: number[];
  domains?: Domain[];
  resources?: { cpuCores?: number; memoryMb?: number };
  backups?: { file: string; size: number; at: string | Date }[];
  /** 该实例能否自动恢复（服务端按引擎能力判定；false = 只能下载后手动执行） */
  backupRestorable?: boolean;
  metrics?: Metrics | null;
}

export const fmtBytes = (n: number) =>
  n >= 1 << 30
    ? `${(n / (1 << 30)).toFixed(1)} GB`
    : n >= 1 << 20
      ? `${(n / (1 << 20)).toFixed(1)} MB`
      : `${(n / 1024).toFixed(0)} KB`;

export const fmtAgo = (d: Date | string) => {
  const s = Math.max(
    1,
    Math.round((Date.now() - new Date(d).getTime()) / 1000),
  );
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.round(s / 60)}m 前`;
  if (s < 86400) return `${Math.round(s / 3600)}h 前`;
  return new Date(d).toLocaleDateString("zh-CN");
};


export type Mutate = (
  fn: () => Promise<{ notice?: string }>,
  opts?: { refreshBoard?: boolean; reload?: boolean },
) => Promise<void>;
