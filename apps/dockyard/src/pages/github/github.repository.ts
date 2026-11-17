import { desc, eq } from "drizzle-orm";
import type { Db } from "../../shared/db";
import { githubApps } from "./schema";

/** GitHub App 安装凭据的持久化（私钥/webhook secret 已加密，仓库层只搬运密文） */
export class GithubRepository {
  constructor(private readonly db: Db) {}

  /** 当前生效的 App（最新一条；多条并存时以最新为准） */
  async current() {
    return this.db
      .select()
      .from(githubApps)
      .orderBy(desc(githubApps.id))
      .limit(1)
      .then((r) => r[0]);
  }

  /** 保存（同一 installationId 覆盖，否则新增） */
  async save(input: {
    appId: string;
    installationId: string;
    privateKeyEnc: string;
    webhookSecretEnc: string | null;
    accountLogin: string | null;
  }) {
    const existing = await this.db
      .select()
      .from(githubApps)
      .where(eq(githubApps.installationId, input.installationId))
      .limit(1);
    if (existing[0]) {
      await this.db
        .update(githubApps)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(githubApps.id, existing[0].id));
      return existing[0].id;
    }
    const [row] = await this.db.insert(githubApps).values(input).returning();
    return row!.id;
  }

  async remove(id: number) {
    await this.db.delete(githubApps).where(eq(githubApps.id, id));
  }
}
