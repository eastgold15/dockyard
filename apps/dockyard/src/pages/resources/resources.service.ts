import { ServiceError } from "@elysiax/core";
import { decryptSecret, encryptSecret } from "../../shared/crypto";
import { shq } from "../../shared/shell";
import type { ServerResource } from "./schema";
import {
  assertSafeResourceName,
  dbCompose,
  instanceUrl,
  sharedContainerNameOf,
  suggestedEnvKey,
  type DbType,
} from "./db-templates";
import { openServerSftp, type ServerService } from "../servers/servers.socket";
import type { NewResource, ResourceRepository } from "./resources.repository";

/** credsJson 解密后的结构：模板 compose/env + 部署成功后回填的连接串 */
export interface ResourceCreds {
  compose: string;
  env: string;
  url: string | null;
  /** 模板定死的 compose 项目名（新资源有；存量资源缺失 = 沿用目录名） */
  project?: string;
  port?: number;
}

/** 解析 credsJson：null = 还没写模板（跳过即可）；损坏（密钥变更/行截断）= ServiceError，
 *  不能把 SyntaxError 漏给 actions。 */
function credsOf(resource: ServerResource): ResourceCreds | null {
  if (!resource.credsJson) return null;
  try {
    return JSON.parse(decryptSecret(resource.credsJson)) as ResourceCreds;
  } catch {
    throw new ServiceError(`共享资源「${resource.name}」的凭据损坏（密钥变更或数据截断），请删除后重建`);
  }
}

/** 键名会原样写进业务 app 的 .env：含空白/等号/换行就能注入额外变量 */
function assertEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ServiceError(`非法的环境变量名: ${key}`);
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
    const name = input.name.trim();
    assertSafeResourceName(name);
    const existing = await this.repo.ofServer(input.serverId);
    if (existing.some((r) => r.name === name))
      throw new ServiceError(`服务器上已存在同名共享资源「${name}」`);
    const envKey = input.envKey?.trim() || suggestedEnvKey(input.dbType);
    assertEnvKey(envKey);
    const resource = await this.repo.create({
      ...input,
      name,
      envKey,
    } satisfies NewResource);
    const rendered = dbCompose(input.dbType, name, { resourceId: resource.id });
    await this.repo.update(resource.id, {
      containerName: sharedContainerNameOf(resource.id, name),
      credsJson: encryptSecret(JSON.stringify({ ...rendered, url: null } satisfies ResourceCreds & { port: number })),
    });
    return (await this.repo.byId(resource.id))!;
  }

  /** 部署中间件到服务器（视角 B）：对账 → SFTP 推模板 → compose up → 生成连接串 */
  async deploy(id: number): Promise<void> {
    const resource = await this.mustGet(id);
    if (!resource.containerName) throw new ServiceError("共享资源缺少容器名，请删除后重建");
    // 存量行可能早于创建时白名单：名字要拼进远端路径，部署前再验一次
    assertSafeResourceName(resource.name);
    const creds = credsOf(resource);
    if (!creds) throw new ServiceError("共享资源缺少模板内容，请删除后重建");
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

    const client = await this.serverService.transport(resource.serverId);
    const { stdout } = await client.exec('printf %s "$HOME"');
    const home = stdout.trim();
    if (!home) throw new ServiceError("无法解析远端家目录，共享资源部署中止");
    const absDir = `${home}/dockyard/shared/${resource.name}`;
    await client.exec(`mkdir -p ${shq(absDir)}`);
    const sftp = await openServerSftp(client);
    try {
      await sftp.write(`${absDir}/docker-compose.yml`, creds.compose);
      await sftp.write(`${absDir}/.env`, creds.env);
    } finally {
      // 失败也要关：远程 SFTP 是共享 SSH 连接上的通道，泄漏会越攒越多
      await sftp.close();
    }
    // 不补 -p：新资源的项目名由模板顶层 name 定死；存量资源 compose 无 name，
    // 沿用目录名——强行 -p dockyard-res-<id> 会换 project，卷名跟着变，旧数据留在旧卷里
    const up = await client.exec(`cd ${shq(absDir)} && docker compose up -d`);
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
    const key = envKey.trim();
    assertEnvKey(key);
    return this.repo.update(id, { envKey: key });
  }

  /** 连接串（仅本机控制面回显/注入用） */
  async urlOf(id: number): Promise<string | null> {
    return credsOf(await this.mustGet(id))?.url ?? null;
  }

  /** 某台服务器全部可注入的共享变量（url 已解密；只含部署成功的资源） */
  async sharedEnvOf(serverId: number): Promise<SharedEnv[]> {
    const out: SharedEnv[] = [];
    for (const r of await this.repo.ofServer(serverId)) {
      const url = credsOf(r)?.url;
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
