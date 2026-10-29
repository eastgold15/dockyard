import { eq } from "drizzle-orm";
import type { Db } from "../../shared/db";
import { parseOwnerRepo, type GithubService } from "../github/github.socket";
import type { DeployService } from "./deploy.service";
import { deployTargets, type DeployTarget } from "./schema";

const INTERVAL_MS = 60_000;

/** 更新判定（纯函数）：available = 有已知基线且 HEAD 变了；autoTrigger 同一 sha 只触发一次（防失败风暴） */
export function updateDecision(opts: {
  lastKnownSha: string | null;
  headSha: string;
  deployPolicy: DeployTarget["deployPolicy"];
  /** 本 target 上次 auto 触发过的 8 位短 sha */
  lastAutoSha?: string;
}): { available: boolean; autoTrigger: boolean; sha8: string } {
  const sha8 = opts.headSha.slice(0, 8);
  const available = opts.lastKnownSha !== null && sha8 !== opts.lastKnownSha;
  return {
    available,
    autoTrigger: opts.deployPolicy === "auto" && available && opts.lastAutoSha !== sha8,
    sha8,
  };
}

/** 本地仓库 HEAD 短 sha（非 git 目录/命令失败 → null，轮询静默跳过） */
export async function gitHeadSha(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--short=8", "HEAD"], { cwd, stdout: "pipe", stderr: "ignore" });
    const sha = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && sha ? sha : null;
  } catch {
    return null;
  }
}

/**
 * 后台更新轮询（替代 webhook）：对每个 app 目标取「最新源码版本」，
 * 与 lastKnownSha 不同则按 deployPolicy 行事——
 *   manual：不轮询（省 GitHub 配额 / 不碰本地仓库）
 *   notify：置 updateAvailable 徽章（默认，存量行为）
 *   auto  ：检出更新直接触发部署（trigger=auto）
 * 版本来源与部署形态同源：本地来源看**本地 git HEAD**（localAppForm 用它做 sha），
 * 其余看 GitHub 分支最新 sha——两条链路同一个判定，徽章才不会一边亮一边不亮。
 * 本地来源只认已提交的 HEAD：工作区未提交改动不算「有更新」。
 * auto 防风暴：内存记「上次 auto 触发的 sha」，同 sha 部署失败不会每分钟重试，
 * 新 sha 到来才再次触发；用户手动部署成功后 lastKnownSha 对齐，徽章自然消除。
 * DI 装配（deploy.di.ts provide），index.ts 从根容器取出后 start()。
 */
export class UpdatePoller {
  private timer?: ReturnType<typeof setInterval>;
  /** targetId → 已 auto 触发过的 sha（8 位短 sha） */
  private readonly lastAutoSha = new Map<number, string>();

  constructor(
    private readonly github: GithubService,
    private readonly db: Db,
    private readonly deploy: DeployService,
  ) {}

  start(intervalMs = INTERVAL_MS) {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    return this.timer;
  }

  /** 目标的最新源码版本；304（GitHub 未变）/ 不可读 → null（本轮跳过） */
  private async headOf(target: DeployTarget): Promise<{ sha: string; etag?: string } | null> {
    const localDir = await this.deploy.localDirOf(target);
    if (localDir) {
      const sha = await gitHeadSha(localDir);
      return sha ? { sha } : null;
    }
    if (!target.repoUrl) return null;
    let ownerRepo: string;
    try {
      ownerRepo = parseOwnerRepo(target.repoUrl);
    } catch {
      return null;
    }
    return this.github.latestSha(ownerRepo, target.branch ?? "main", target.etag ?? undefined);
  }

  private async tick() {
    const apps = await this.db.select().from(deployTargets).where(eq(deployTargets.kind, "app"));
    for (const target of apps) {
      if (target.deployPolicy === "manual") continue; // 手动策略完全不碰远端/本地仓库
      try {
        const head = await this.headOf(target);
        if (!head) continue; // 304 无变化 / 本地仓库不可读
        const decision = updateDecision({
          lastKnownSha: target.lastKnownSha,
          headSha: head.sha,
          deployPolicy: target.deployPolicy,
          lastAutoSha: this.lastAutoSha.get(target.id),
        });
        await this.db.update(deployTargets).set({
          ...(head.etag !== undefined ? { etag: head.etag } : {}),
          updateAvailable: decision.available,
        }).where(eq(deployTargets.id, target.id));

        if (decision.autoTrigger) {
          this.lastAutoSha.set(target.id, decision.sha8);
          void this.deploy.deploy(target.id, { trigger: "auto" });
        }
      } catch (error) {
        console.warn(`[poller] target ${target.id}: ${(error as Error).message}`);
      }
    }
  }
}
