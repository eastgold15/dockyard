/** projects 的 HTTP 契约类型（服务端 actions 与 Solid client 共用，纯类型无值导入）。 */
import type { Project } from "./schema";
import type { LocalProject } from "./local.service";
import type { RepoBrief } from "@/pages/github/github.socket";

export interface ProjectListModel {
  local: LocalProject[];
  /** 绑定了 GitHub 仓库但不在本地扫描结果里的项目空间 */
  remote: Project[];
  editors: string[];
  defaultEditor: string;
  lazygit: boolean;
}

export interface ScanConfig {
  scanDirs: string[];
}

export interface NewProjectData {
  repos: RepoBrief[];
  error?: string;
}

export type { LocalProject, Project, RepoBrief };
