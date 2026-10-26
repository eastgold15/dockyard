import { ServiceError } from "@elysiax/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { parse as parseYaml } from "yaml";

export interface RepoBrief {
  fullName: string;
  branch: string;
  private: boolean;
  updatedAt: string;
}

/** gh CLI 认证 piggyback（openship github.local-auth.ts 同款思路） */
export class GithubService {
  private tokenCache: { token: string; at: number } | null = null;

  /** gh auth token → 失败回退读 hosts.yml。缓存 10 分钟 */
  async token(): Promise<string> {
    if (this.tokenCache && Date.now() - this.tokenCache.at < 10 * 60_000) {
      return this.tokenCache.token;
    }
    const proc = await $`gh auth token`.nothrow().quiet();
    const token = proc.stdout.toString().trim();
    if (proc.exitCode === 0 && token) {
      this.tokenCache = { token, at: Date.now() };
      return token;
    }
    const hostsYml = readFileSync(join(Bun.env.HOME ?? "", ".config", "gh", "hosts.yml"), "utf8");
    const doc = parseYaml(hostsYml) as Record<string, { oauth_token?: string }> | null;
    const fallback = doc?.["github.com"]?.oauth_token;
    if (!fallback) throw new ServiceError("未找到 GitHub 凭据：请先 `gh auth login`");
    this.tokenCache = { token: fallback, at: Date.now() };
    return fallback;
  }

  /** 当前登录用户（UI 展示用） */
  async whoami(): Promise<string> {
    const proc = await $`gh api user --jq .login`.nothrow().quiet();
    if (proc.exitCode !== 0) throw new ServiceError("gh 未登录");
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
    const args = [
      "api", `repos/${ownerRepo}/commits/${branch}`,
      "--jq", ".sha",
      "--include",
    ];
    if (etag) args.push("-H", `If-None-Match: ${etag}`);
    const proc = await $`gh ${args}`.nothrow().quiet();
    const raw = proc.stdout.toString();
    // 304 时 gh 对空 body 解析 JSON 报错退出——headers 已打印，先判 304 再判错误
    if (/\b304\b/.test(raw.split("\n")[0] ?? "")) return null;
    if (proc.exitCode !== 0) throw new ServiceError(`gh api 失败: ${proc.stderr.toString()}`);
    const etagMatch = raw.match(/^[Ee][Tt]ag:\s*(\S+)/m);
    const sha = raw.trim().split("\n").pop()?.trim();
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new ServiceError(`解析 sha 失败: ${raw.slice(-200)}`);
    return { sha, etag: etagMatch?.[1] };
  }

  /** 账号可选仓库列表（部署向导的仓库选择器；缓存 5 分钟，160+ 仓库不能每次都拉） */
  private reposCache: { repos: RepoBrief[]; at: number } | null = null;
  async listRepos(): Promise<RepoBrief[]> {
    if (this.reposCache && Date.now() - this.reposCache.at < 5 * 60_000) return this.reposCache.repos;
    const proc = await $`gh repo list --limit 300 --json nameWithOwner,defaultBranchRef,visibility,updatedAt`
      .nothrow().quiet();
    if (proc.exitCode !== 0)
      throw new ServiceError(`gh repo list 失败: ${proc.stderr.toString()}`);
    const raw = proc.json() as {
      nameWithOwner: string;
      defaultBranchRef?: { name: string } | null;
      visibility: string;
      updatedAt: string;
    }[];
    const repos = raw.map((r) => ({
      fullName: r.nameWithOwner,
      branch: r.defaultBranchRef?.name ?? "main",
      private: r.visibility !== "PUBLIC",
      updatedAt: r.updatedAt,
    }));
    this.reposCache = { repos, at: Date.now() };
    return repos;
  }

  /** 单文件内容（contents API，base64）。404 → null；识别流程用它免去整库克隆 */
  async fileContent(ownerRepo: string, path: string, ref: string): Promise<string | null> {
    const proc = await $`gh api ${`repos/${ownerRepo}/contents/${path}?ref=${encodeURIComponent(ref)}`} --jq .content`
      .nothrow().quiet();
    if (proc.exitCode !== 0) {
      const err = proc.stderr.toString();
      if (/404|Not Found/i.test(err)) return null;
      throw new ServiceError(`gh api 读 ${path} 失败: ${err.slice(0, 200)}`);
    }
    // base64 里带换行，Buffer.from 容忍；contents API 单文件上限 1MB，openship.json/compose 远低于此
    return Buffer.from(proc.stdout.toString().trim(), "base64").toString("utf8");
  }

  /** clone / fetch 用的带 token URL（用完必须重写 remote，见 deploy） */
  async authedRepoUrl(ownerRepo: string): Promise<string> {
    return `https://x-access-token:${await this.token()}@github.com/${ownerRepo}.git`;
  }
}
