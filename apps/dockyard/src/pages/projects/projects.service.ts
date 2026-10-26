import { basename } from "node:path";
import { parseOwnerRepo } from "../github/github.socket";
import { readGitRemote } from "./local.service";
import type { ProjectRepository } from "./projects.repository";

export class ProjectService {
  constructor(private readonly repo: ProjectRepository) {}

  list() {
    return this.repo.list();
  }

  byId(id: number) {
    return this.repo.byId(id);
  }

  /** 项目 = 仓库：repoUrl 可空（纯数据库项目空间），非空先校验格式 */
  create(name: string, repoUrl?: string) {
    if (repoUrl?.trim()) parseOwnerRepo(repoUrl);
    return this.repo.create(name, repoUrl?.trim() || undefined, undefined, "github");
  }

  /** 本地项目点击进画布：扫描即展示，此刻才落库（按 localPath 幂等） */
  async ensureLocal(localPath: string) {
    const existing = await this.repo.byLocalPath(localPath);
    if (existing) return existing;
    return this.repo.create(basename(localPath), await readGitRemote(localPath), localPath, "local");
  }

  remove(id: number) {
    return this.repo.remove(id);
  }
}
