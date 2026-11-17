import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// ── GitHub App 安装凭据：App 身份 + 私钥（enc1 加密）──
// appId/installationId 由 GitHub 侧给出；私钥是 App 的身份凭据，等价于密码，
// 必须加密落库（与 deploy_artifacts 的秘密快照同标准）。
export const githubApps = sqliteTable("github_apps", {
  id: integer().primaryKey({ autoIncrement: true }),
  // GitHub App 的 App ID（数字串）
  appId: text().notNull(),
  // 安装实例 ID（把 App 装到账号/组织后得到）
  installationId: text().notNull(),
  // App 私钥 PEM（enc1: 加密）
  privateKeyEnc: text().notNull(),
  // webhook 签名密钥（enc1: 加密；可选——只有走 webhook 才需要）
  webhookSecretEnc: text(),
  // 安装账号登录名（展示用，保存时从 GitHub 读一次）
  accountLogin: text(),
  createdAt: integer({ mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer({ mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type GithubApp = typeof githubApps.$inferSelect;
