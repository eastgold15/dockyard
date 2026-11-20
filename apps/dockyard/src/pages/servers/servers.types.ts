/** servers 的 HTTP 契约类型（服务端 actions 与 Solid client 共用，纯类型无值导入）。 */
import type { Server } from "./schema";
import type { ServerResource } from "@/pages/resources/resources.socket";

export type CheckResult =
  | { ok: true; dockerVersion: string; warning?: string }
  | {
      ok: false;
      reason: "docker-missing" | "ssh-failed" | "local-failed";
      message: string;
    }
  | { ok: false; reason: "need-trust"; fingerprint: string; algorithm: string };

export interface ServersModel {
  servers: Server[];
}

export interface CheckResponse {
  server: Server;
  result: CheckResult;
}

export interface InstallDockerResponse {
  server: Server;
  code: number;
  output: string;
}

export interface MirrorsResponse {
  server: Server;
  result: { applied: boolean; mirrors: string[]; output: string };
}

export interface ResourceItem {
  resource: ServerResource;
  url: string | null;
}

export interface ResourcesResponse {
  server: Server;
  resources: ResourceItem[];
}
