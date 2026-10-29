/**
 * 共享资源的创建前门禁 + 凭据解析：
 * 校验必须发生在加密落库之前（错的键名/名字不该留下半条记录），
 * 损坏的 credsJson 要变成 ServiceError 而不是 SyntaxError。
 */
import { expect, test } from "bun:test";
import { ServiceError } from "@elysiax/core";
import type { ServerService } from "../servers/servers.socket";
import type { ResourceRepository } from "./resources.repository";
import type { ServerResource } from "./schema";
import { ResourceService } from "./resources.service";

const row = (patch: Partial<ServerResource>): ServerResource =>
  ({
    id: 1,
    serverId: 1,
    name: "cache",
    dbType: "redis",
    containerName: "dockyard-res-1-cache",
    envKey: "REDIS_URL",
    credsJson: null,
    createdAt: new Date(),
    ...patch,
  }) as ServerResource;

const serviceWith = (repo: Partial<ResourceRepository>) =>
  new ResourceService(repo as ResourceRepository, {} as ServerService);

test("create：非法 envKey 在落库前就被拒（换行/等号会注入 .env；空 = 用默认键）", async () => {
  const svc = serviceWith({
    ofServer: async () => [],
    create: async () => { throw new Error("不该走到落库"); },
  });
  for (const bad of ["A B", "A=B", "A\nB", "1A"]) {
    await expect(svc.create({ serverId: 1, name: "cache", dbType: "redis", envKey: bad }))
      .rejects.toBeInstanceOf(ServiceError);
  }
});

test("create：非法资源名在落库前就被拒", async () => {
  const svc = serviceWith({
    ofServer: async () => [],
    create: async () => { throw new Error("不该走到落库"); },
  });
  await expect(svc.create({ serverId: 1, name: "a;rm -rf /", dbType: "redis" }))
    .rejects.toThrow(/名称只允许/);
});

test("urlOf：credsJson 未写 → null；损坏 → ServiceError（不是 SyntaxError）", async () => {
  const missing = serviceWith({ byId: async () => row({ credsJson: null }) });
  expect(await missing.urlOf(1)).toBeNull();

  const broken = serviceWith({ byId: async () => row({ credsJson: "not-json" }) });
  await expect(broken.urlOf(1)).rejects.toThrow(/凭据损坏/);
});

test("updateEnvKey：先 trim 再校验", async () => {
  const seen: string[] = [];
  const svc = serviceWith({
    // drizzle 的 update 返回查询构建器（惰性），假实现只需可 await
    update: (async (_id: number, patch: { envKey: string }) => { seen.push(patch.envKey); return row(patch); }) as unknown as ResourceRepository["update"],
  });
  await svc.updateEnvKey(1, "  REDIS_URL  ");
  expect(seen).toEqual(["REDIS_URL"]);
});
