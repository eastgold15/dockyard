import { ServiceError } from "@elysiax/core";
import { openSftp } from "@meitaim/ssh/sftp";
import { decryptSecret, encryptSecret } from "../../shared/crypto";
import type { ServerResource } from "./schema";
import {
  dbCompose,
  instanceUrl,
  sharedContainerNameOf,
  suggestedEnvKey,
  type DbType,
} from "./db-templates";
import type { ServerService } from "../servers/servers.socket";
import type { NewResource, ResourceRepository } from "./resources.repository";

/** credsJson 解密后的结构：模板 compose/env + 部署成功后回填的连接串 */
export interface ResourceCreds {
  compose: string;
  env: string;
  url: string | null;
}

/** 共享环境变量（注入业务 app 的 .env / Env 下拉引用用） */
export interface SharedEnv {
  resourceId: number;
  name: string;
  dbType: DbType;
  envKey: string;
  url: string;
}

export class ResourceService {
  constructor(
    private readonly repo: ResourceRepository,
    private readonly serverService: ServerService,
  ) {}

  ofServer(serverId: number) {
    return this.repo.ofServer(serverId);
  }

  byId(id: number) {
    return this.repo.byId(id);
  }

  /** 创建共享资源：模板 compose + 凭据创建时生成一次，enc1: 加密存 credsJson（url 部署成功后回填） */
  async create(input: { serverId: number; name: string; dbType: DbType; envKey?: string }) {
    const existing = await this.repo.ofServer(input.serverId);
    if (existing.some((r) => r.name === input.name))
      throw new ServiceError(`服务器上已存在同名共享资源「${input.name}」`);
    const resource = await this.repo.create({
      ...input,
      envKey: input.envKey?.trim() || suggestedEnvKey(input.dbType),
    } satisfies NewResource);
    const rendered = dbCompose(input.dbType, input.name, { resourceId: resource.id });
    await this.repo.update(resource.id, {
      containerName: sharedContainerNameOf(resource.id, input.name),
      credsJson: encryptSecret(JSON.stringify({ ...rendered, url: null } satisfies ResourceCreds & { port: number })),
    });
    return (await this.repo.byId(resource.id))!;
  }

  /** 部署中间件到服务器（视角 B）：对账 → SFTP 推模板 → compose up → 生成连接串 */
  async deploy(id: number): Promise<void> {
    const resource = await this.mustGet(id);
    if (!resource.credsJson || !resource.containerName) throw new ServiceError("共享资源缺少模板内容");
    const creds = JSON.parse(decryptSecret(resource.credsJson)) as ResourceCreds;
    const server = await this.serverService.byId(resource.serverId);
    if (!server) throw new ServiceError("服务器不存在");

    // 部署前对账：远端同名容器必须是本资源管理的，绝不动别人的容器
    const remote = await this.serverService.docker(resource.serverId);
    const containers = await remote.listContainers({ all: true });
    const hit = containers.find((c) => c.Names.includes(`/${resource.containerName}`));
    if (hit) {
      const managed = hit.Labels?.["dockyard.managed"] === "true";
      const owner = hit.Labels?.["dockyard.shared-resource"];
      if (!(managed && owner === String(resource.id)))
        throw new ServiceError(
          managed
            ? `远端容器 ${resource.containerName} 属于另一个共享资源（#${owner}），已阻止部署`
            : `远端已存在非本工具管理的同名容器 ${resource.containerName}，已阻止部署`,
        );
    }

    const client = await this.serverService.ssh(resource.serverId);
    const { stdout: home } = await client.exec('printf %s "$HOME"');
    const absDir = `${home.trim()}/dockyard/shared/${resource.name}`;
    await client.exec(`mkdir -p ${absDir}`);
    const sftp = await openSftp(client);
    await sftp.write(`${absDir}/docker-compose.yml`, creds.compose);
    await sftp.write(`${absDir}/.env`, creds.env);
    await sftp.close();
    const up = await client.exec(`cd ${absDir} && docker compose up -d`);
    if (up.code !== 0) throw new ServiceError(`远端 compose up 失败（exit ${up.code}）\n${up.stdout}${up.stderr}`);

    // 部署成功：生成连接串，写入共享清单（服务器级共享变量）
    const url = instanceUrl(resource.dbType, server.host, creds.env);
    await this.repo.update(id, {
      credsJson: encryptSecret(JSON.stringify({ ...creds, url } satisfies ResourceCreds)),
    });
  }

  /** 删除记录（保守：不动远端容器和数据卷，需要清理请手动） */
  remove(id: number) {
    return this.repo.remove(id);
  }

  /** 更新 envKey（共享变量键名） */
  async updateEnvKey(id: number, envKey: string) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) throw new ServiceError(`非法的环境变量名: ${envKey}`);
    return this.repo.update(id, { envKey });
  }

  /** 连接串（仅本机控制面回显/注入用） */
  async urlOf(id: number): Promise<string | null> {
    const resource = await this.mustGet(id);
    if (!resource.credsJson) return null;
    return (JSON.parse(decryptSecret(resource.credsJson)) as ResourceCreds).url;
  }

  /** 某台服务器全部可注入的共享变量（url 已解密；只含部署成功的资源） */
  async sharedEnvOf(serverId: number): Promise<SharedEnv[]> {
    const out: SharedEnv[] = [];
    for (const r of await this.repo.ofServer(serverId)) {
      if (!r.credsJson) continue;
      const { url } = JSON.parse(decryptSecret(r.credsJson)) as ResourceCreds;
      if (url) out.push({ resourceId: r.id, name: r.name, dbType: r.dbType, envKey: r.envKey, url });
    }
    return out;
  }

  private async mustGet(id: number): Promise<ServerResource> {
    const r = await this.repo.byId(id);
    if (!r) throw new ServiceError(`共享资源不存在: ${id}`);
    return r;
  }
}
