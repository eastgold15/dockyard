import { ServiceError } from "@elysiax/core";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSign } from "node:crypto";
import { $ } from "bun";
import { parse as parseYaml } from "yaml";
import { appPaths } from "../../shared/paths";
import { decryptSecret, encryptSecret } from "../../shared/crypto";
import type { GithubRepository } from "./github.repository";

const API = "https://api.github.com";
/** GitHub API 强制要求 User-Agent */
const UA = "dockyard";

export interface RepoBrief {
  fullName: string;
  branch: string;
  private: boolean;
  updatedAt: string;
}

/** GitHub App 安装态（DB 行的解密视图） */
export interface AppInstall {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  webhookSecret: string | null;
  accountLogin: string | null;
}

/** App 授权状态（对外展示；不泄露私钥） */
export interface AppStatus {
  /** 是否已配置 GitHub App */
  configured: boolean;
  /** 凭据来源：app = GitHub App 安装令牌；gh = 回落 gh CLI / hosts.yml */
  source: "app" | "gh";
  appId?: string;
  installationId?: string;
  accountLogin?: string | null;
  webhookSecretSet?: boolean;
}

/**
 * GitHub 访问层。
 *
 * 两种凭据：
 * 1. GitHub App（首选）：App 私钥签 JWT → 换 installation token（1 小时）。
 *    权限只覆盖「App 被安装到的那些仓库」，API 与 git 拉取共用同一个 token
 *    （git 凭据形如 x-access-token:<installation_token>），不依赖 gh CLI、不依赖个人 PAT。
 * 2. gh CLI 兜底（未配置 App 时）：行为与原来一致。
 */
export class GithubService {
  private tokenCache: { token: string; at: number } | null = null;
  /** installation token 缓存（1 小时 TTL，提前 5 分钟换新） */
  private appTokenCache: {
    installationId: string;
    token: string;
    expiresAt: number;
  } | null = null;

  constructor(private readonly repo: GithubRepository) {}

  // ── App 安装态 ────────────────────────────────────────────────
  /** 安装态缓存（读库 + 解私钥，30s）——凭据只在保存/删除时变，缓存由那两处失效 */
  private installCache: { install: AppInstall | null; at: number } | null = null;

  /** 当前安装态（读库 + 解密）；未配置返回 null */
  async appInstall(): Promise<AppInstall | null> {
    if (this.installCache && Date.now() - this.installCache.at < 30_000)
      return this.installCache.install;
    const row = await this.repo.current();
    if (!row) {
      this.installCache = { install: null, at: Date.now() };
      return null;
    }
    let install: AppInstall;
    try {
      install = {
        appId: row.appId,
        installationId: row.installationId,
        privateKeyPem: decryptSecret(row.privateKeyEnc),
        webhookSecret: row.webhookSecretEnc
          ? decryptSecret(row.webhookSecretEnc)
          : null,
        accountLogin: row.accountLogin,
      };
    } catch (error) {
      throw new ServiceError(
        `GitHub App 私钥解密失败（数据目录密钥可能已换）：${(error as Error).message}`,
      );
    }
    this.installCache = { install, at: Date.now() };
    return install;
  }

  /** 授权状态（UI 展示用） */
  async appStatus(): Promise<AppStatus> {
    const install = await this.appInstall();
    if (!install) return { configured: false, source: "gh" };
    return {
      configured: true,
      source: "app",
      appId: install.appId,
      installationId: install.installationId,
      accountLogin: install.accountLogin,
      webhookSecretSet: !!install.webhookSecret,
    };
  }

  /**
   * 保存 App 凭据：先验证（换 token + 读安装账号），验证不过直接拒绝——
   * 不把不可用的私钥存进库。
   */
  async saveApp(input: {
    appId: string;
    installationId: string;
    privateKeyPem: string;
    webhookSecret?: string | null;
  }): Promise<AppStatus> {
    const appId = input.appId.trim();
    const installationId = input.installationId.trim();
    const privateKeyPem = input.privateKeyPem.trim();
    if (!appId || !installationId || !privateKeyPem)
      throw new ServiceError("App ID、Installation ID、私钥都要填");
    const webhookSecret = input.webhookSecret?.trim() || null;
    const install: AppInstall = {
      appId,
      installationId,
      privateKeyPem,
      webhookSecret,
      accountLogin: null,
    };
    // 验证：签 JWT → 换 installation token → 读安装账号
    await this.appToken(install, true);
    const accountLogin = await this.installationAccount(install);
    await this.repo.save({
      appId,
      installationId,
      privateKeyEnc: encryptSecret(privateKeyPem),
      webhookSecretEnc: webhookSecret ? encryptSecret(webhookSecret) : null,
      accountLogin,
    });
    this.appTokenCache = null;
    this.tokenCache = null;
    this.installCache = null;
    return this.appStatus();
  }

  /** 解除 App 授权（删凭据，回落 gh CLI） */
  async removeApp(): Promise<void> {
    const row = await this.repo.current();
    if (!row) return;
    await this.repo.remove(row.id);
    this.appTokenCache = null;
    this.tokenCache = null;
    this.installCache = null;
  }

  // ── 凭据 ─────────────────────────────────────────────────────
  /** RS256 JWT（App 身份）：iss = App ID，10 分钟内有效 */
  private appJwt(install: AppInstall): string {
    const now = Math.floor(Date.now() / 1000);
    const b64 = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString("base64url");
    const signingInput = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
      iat: now,
      exp: now + 540,
      iss: install.appId,
    })}`;
    try {
      const signature = createSign("RSA-SHA256")
        .update(signingInput)
        .end()
        .sign(install.privateKeyPem, "base64url");
      return `${signingInput}.${signature}`;
    } catch (error) {
      throw new ServiceError(
        `GitHub App 私钥签名失败（私钥格式不对？）：${(error as Error).message}`,
      );
    }
  }

  /** installation token（App 权限，1 小时） */
  private async appToken(
    install: AppInstall,
    force = false,
  ): Promise<string> {
    const now = Date.now();
    if (
      !force &&
      this.appTokenCache &&
      this.appTokenCache.installationId === install.installationId &&
      this.appTokenCache.expiresAt - now > 5 * 60_000
    )
      return this.appTokenCache.token;
    const jwt = this.appJwt(install);
    const res = await fetch(
      `${API}/app/installations/${install.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": UA,
        },
      },
    );
    if (!res.ok)
      throw new ServiceError(
        `GitHub App 换取 installation token 失败（${res.status}）：${(await res.text()).slice(0, 300)}`,
      );
    const data = (await res.json()) as {
      token?: string;
      expires_at?: string;
    };
    if (!data.token) throw new ServiceError("GitHub App 未返回 installation token");
    this.appTokenCache = {
      installationId: install.installationId,
      token: data.token,
      expiresAt: data.expires_at
        ? Date.parse(data.expires_at)
        : now + 50 * 60_000,
    };
    return data.token;
  }

  /** 安装账号登录名（App JWT 读 /installation） */
  private async installationAccount(
    install: AppInstall,
  ): Promise<string | null> {
    const res = await fetch(`${API}/installation`, {
      headers: {
        Authorization: `Bearer ${this.appJwt(install)}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": UA,
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { account?: { login?: string } };
    return data.account?.login ?? null;
  }

  /** API 请求（统一走 Bearer token + GitHub 版本头） */
  private async apiRequest(
    path: string,
    init: RequestInit = {},
    etag?: string,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await this.token()}`);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    headers.set("User-Agent", UA);
    if (etag) headers.set("If-None-Match", etag);
    return fetch(`${API}${path}`, { ...init, headers });
  }

  /** 访问令牌：App installation token 优先，回落 gh CLI / hosts.yml */
  async token(): Promise<string> {
    const install = await this.appInstall();
    if (install) {
      try {
        return await this.appToken(install);
      } catch (error) {
        // App 失效（被卸载 / 私钥轮换 / 安装实例被删）不该让整个工具罢工：
        // 有 gh 登录态就回落 gh（App 的错误信息仍打出来，别静默降级）
        const fallback = await this.ghToken().catch(() => null);
        if (!fallback) throw error;
        console.warn(
          `[github] GitHub App 令牌不可用，已回落 gh CLI：${(error as Error).message}`,
        );
        return fallback;
      }
    }
    return this.ghToken();
  }

  /** gh CLI 凭据（10 分钟缓存）：gh auth token → hosts.yml */
  private async ghToken(): Promise<string> {
    if (this.tokenCache && Date.now() - this.tokenCache.at < 10 * 60_000) {
      return this.tokenCache.token;
    }
    const proc = await $`gh auth token`.nothrow().quiet();
    const token = proc.stdout.toString().trim();
    if (proc.exitCode === 0 && token) {
      this.tokenCache = { token, at: Date.now() };
      return token;
    }
    const hostsYml = readFileSync(
      join(Bun.env.HOME ?? "", ".config", "gh", "hosts.yml"),
      "utf8",
    );
    const doc = parseYaml(hostsYml) as Record<
      string,
      { oauth_token?: string }
    > | null;
    const fallback = doc?.["github.com"]?.oauth_token;
    if (!fallback)
      throw new ServiceError(
        "未找到 GitHub 凭据：配置 GitHub App，或先 `gh auth login`",
      );
    this.tokenCache = { token: fallback, at: Date.now() };
    return fallback;
  }

  /** 当前身份（UI 展示用）：App 安装账号优先，回落 gh 用户 */
  async whoami(): Promise<string> {
    const install = await this.appInstall();
    if (install?.accountLogin) return install.accountLogin;
    const proc = await $`gh api user --jq .login`.nothrow().quiet();
    if (proc.exitCode !== 0)
      throw new ServiceError("GitHub 未授权：配置 GitHub App 或先 `gh auth login`");
    return proc.stdout.toString().trim();
  }

  /**
   * 分支最新 commit（ETag 省配额）。
   * 返回 null 表示 304 无变化。
   */
  async latestSha(
    ownerRepo: string,
    branch: string,
    etag?: string,
  ): Promise<{ sha: string; etag?: string } | null> {
    const res = await this.apiRequest(
      `/repos/${ownerRepo}/commits/${encodeURIComponent(branch)}`,
      {},
      etag,
    );
    if (res.status === 304) return null;
    if (!res.ok)
      throw new ServiceError(
        `GitHub API 取 ${ownerRepo}@${branch} 失败（${res.status}）：${(await res.text()).slice(0, 200)}`,
      );
    const data = (await res.json()) as { sha?: string };
    if (!data.sha || !/^[0-9a-f]{40}$/.test(data.sha))
      throw new ServiceError(`解析 sha 失败：${ownerRepo}@${branch}`);
    const etagOut = res.headers.get("etag") ?? undefined;
    return { sha: data.sha, etag: etagOut };
  }

  /**
   * 账号仓库列表（部署向导的仓库选择器）。
   * 持久缓存：拉一次落盘（~/.cache/dockyard/gh-repos.json），之后用缓存，
   * 只有手动「刷新仓库列表」才重新拉——避免每次开向导都打列表接口（160+ 仓库很慢）。
   */
  private reposCache: { repos: RepoBrief[]; at: number } | null = null;
  private get reposFile() {
    return join(appPaths.cacheDir, "gh-repos.json");
  }

  private loadReposFromDisk(): RepoBrief[] | null {
    try {
      const parsed = JSON.parse(readFileSync(this.reposFile, "utf8"));
      return Array.isArray(parsed) ? (parsed as RepoBrief[]) : null;
    } catch {
      return null;
    }
  }

  private saveReposToDisk(repos: RepoBrief[]) {
    try {
      writeFileSync(this.reposFile, JSON.stringify(repos), { mode: 0o600 });
    } catch {
      /* 缓存写失败不致命：下次仍可现拉 */
    }
  }

  /** 缓存读（内存 → 磁盘），永不触发 API；无缓存返回 null（向导据此提示手动刷新） */
  async cachedRepos(): Promise<RepoBrief[] | null> {
    if (this.reposCache) return this.reposCache.repos;
    const disk = this.loadReposFromDisk();
    if (disk) {
      this.reposCache = { repos: disk, at: Date.now() };
      return disk;
    }
    return null;
  }

  /** 手动刷新：拉新 → 内存 + 落盘（首次无缓存时客户端后台触发这一次） */
  async refreshRepos(): Promise<RepoBrief[]> {
    const repos = (await this.appInstall())
      ? await this.installationRepos()
      : await this.ghRepos();
    this.reposCache = { repos, at: Date.now() };
    this.saveReposToDisk(repos);
    return repos;
  }

  /** App 授权范围内的仓库（分页拉全） */
  private async installationRepos(): Promise<RepoBrief[]> {
    const repos: RepoBrief[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await this.apiRequest(
        `/installation/repositories?per_page=100&page=${page}`,
      );
      if (!res.ok)
        throw new ServiceError(
          `GitHub App 仓库列表失败（${res.status}）：${(await res.text()).slice(0, 200)}`,
        );
      const data = (await res.json()) as {
        repositories?: {
          full_name: string;
          default_branch?: string | null;
          private: boolean;
          updated_at?: string | null;
        }[];
      };
      const batch = data.repositories ?? [];
      repos.push(
        ...batch.map((r) => ({
          fullName: r.full_name,
          branch: r.default_branch ?? "main",
          private: r.private,
          updatedAt: r.updated_at ?? "",
        })),
      );
      if (batch.length < 100) break;
    }
    return repos;
  }

  /** gh CLI 兜底：账号全部仓库 */
  private async ghRepos(): Promise<RepoBrief[]> {
    const proc =
      await $`gh repo list --limit 300 --json nameWithOwner,defaultBranchRef,visibility,updatedAt`
        .nothrow()
        .quiet();
    if (proc.exitCode !== 0)
      throw new ServiceError(`gh repo list 失败: ${proc.stderr.toString()}`);
    const raw = proc.json() as {
      nameWithOwner: string;
      defaultBranchRef?: { name: string } | null;
      visibility: string;
      updatedAt: string;
    }[];
    return raw.map((r) => ({
      fullName: r.nameWithOwner,
      branch: r.defaultBranchRef?.name ?? "main",
      private: r.visibility !== "PUBLIC",
      updatedAt: r.updatedAt,
    }));
  }

  /** 兼容入口：缓存优先，冷启动时现拉一次（项目创建弹窗用；部署向导走 cachedRepos 不阻塞抽屉） */
  async listRepos(): Promise<RepoBrief[]> {
    return (await this.cachedRepos()) ?? (await this.refreshRepos());
  }

  /** 单文件内容（contents API，base64）。404 → null；识别流程用它免去整库克隆 */
  async fileContent(
    ownerRepo: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    const res = await this.apiRequest(
      `/repos/${ownerRepo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok)
      throw new ServiceError(
        `GitHub API 读 ${path} 失败（${res.status}）：${(await res.text()).slice(0, 200)}`,
      );
    const data = (await res.json()) as {
      content?: string;
      encoding?: string;
    };
    if (!data.content) return null;
    // base64 里带换行，Buffer 容忍；contents API 单文件上限 1MB，dockyard.json/compose 远低于此
    return Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf8");
  }

  /** clone / fetch 用的带 token URL（用完必须重写 remote，见 deploy） */
  async authedRepoUrl(ownerRepo: string): Promise<string> {
    return `https://x-access-token:${await this.token()}@github.com/${ownerRepo}.git`;
  }
}
