import { RESTORE_SUPPORT } from "./backup/backup.socket";
import { BackupService } from "./backup/backup.socket";
import { RuntimeService } from "./runtime/runtime.socket";

/**
 * deploy 页面的控制台组合根（中间者）。
 *
 * 服务抽屉/重启/日志/环境变量/资源限制/交互终端/备份恢复分散在 runtime 与 backup 两个
 * 嵌套原子里；deploy.actions 的窄类型只含 deploy 自己声明的键，取不到它们。
 *
 * 本服务是那两个能力的唯一入口，且**没有任何服务依赖它** → 服务键级图上的叶子，
 * 不构成 deploy ↔ runtime/backup 的回边。
 */
export class DeployConsoleService {
  constructor(
    private readonly runtime: RuntimeService,
    private readonly backup: BackupService,
  ) { }

  // ── 运行态（runtime 嵌套原子） ──

  serviceEnvText(...args: Parameters<RuntimeService["serviceEnvText"]>) {
    return this.runtime.serviceEnvText(...args);
  }

  serviceResources(...args: Parameters<RuntimeService["serviceResources"]>) {
    return this.runtime.serviceResources(...args);
  }

  serviceStats(...args: Parameters<RuntimeService["serviceStats"]>) {
    return this.runtime.serviceStats(...args);
  }

  restartService(...args: Parameters<RuntimeService["restartService"]>) {
    return this.runtime.restartService(...args);
  }

  serviceLogs(...args: Parameters<RuntimeService["serviceLogs"]>) {
    return this.runtime.serviceLogs(...args);
  }

  setServiceEnv(...args: Parameters<RuntimeService["setServiceEnv"]>) {
    return this.runtime.setServiceEnv(...args);
  }

  setServiceResources(...args: Parameters<RuntimeService["setServiceResources"]>) {
    return this.runtime.setServiceResources(...args);
  }

  openConsole(...args: Parameters<RuntimeService["openConsole"]>) {
    return this.runtime.openConsole(...args);
  }

  // ── 备份恢复（backup 嵌套原子） ──

  backupsOf(...args: Parameters<BackupService["backupsOf"]>) {
    return this.backup.backupsOf(...args);
  }

  backupNow(...args: Parameters<BackupService["backupNow"]>) {
    return this.backup.backupNow(...args);
  }

  restore(...args: Parameters<BackupService["restore"]>) {
    return this.backup.restore(...args);
  }

  backupFilePath(...args: Parameters<BackupService["backupFilePath"]>) {
    return this.backup.backupFilePath(...args);
  }

  /** 能否自动恢复由引擎能力单点判定（RESTORE_SUPPORT），client 不重复维护引擎清单 */
  restorableOf(dbType: string | null | undefined): boolean {
    return Boolean(RESTORE_SUPPORT[dbType ?? ""]);
  }
}
