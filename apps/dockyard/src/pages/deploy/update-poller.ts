import { eq } from "drizzle-orm";
import type { Db } from "../../shared/db";
import { parseOwnerRepo, type GithubService } from "../github/github.socket";
import type { DeployService } from "./deploy.service";
import { deployTargets } from "./schema";

const INTERVAL_MS = 60_000;

/**
 * 后台更新轮询（替代 webhook）：对每个 app 目标查分支最新 sha，
 * 与 lastKnownSha 不同则按 deployPolicy 行事——
 *   manual：不轮询（省 GitHub 配额）
 *   notify：置 updateAvailable 徽章（默认，存量行为）
 *   auto  ：检出更新直接触发部署（trigger=auto）
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

  private async tick() {
    const apps = await this.db.select().from(deployTargets).where(eq(deployTargets.kind, "app"));
    for (const target of apps) {
      if (!target.repoUrl) continue;
      if (target.deployPolicy === "manual") continue; // 手动策略完全不碰 GitHub
      try {
        let ownerRepo: string;
        try {
          ownerRepo = parseOwnerRepo(target.repoUrl);
        } catch {
          continue;
        }
        const result = await this.github.latestSha(ownerRepo, target.branch ?? "main", target.etag ?? undefined);
        if (!result) continue; // 304 无变化
        const available = target.lastKnownSha !== null && result.sha.slice(0, 8) !== target.lastKnownSha;
        await this.db.update(deployTargets).set({
          etag: result.etag ?? target.etag,
          updateAvailable: available,
        }).where(eq(deployTargets.id, target.id));

        if (target.deployPolicy === "auto" && available) {
          const sha8 = result.sha.slice(0, 8);
          if (this.lastAutoSha.get(target.id) === sha8) continue;
          this.lastAutoSha.set(target.id, sha8);
          void this.deploy.deploy(target.id, { trigger: "auto" });
        }
      } catch (error) {
        console.warn(`[poller] target ${target.id}: ${(error as Error).message}`);
      }
    }
  }
}
