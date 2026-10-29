/**
 * ServerService 本机语义单测：内存 sqlite 跑全部真迁移（与生产同一份聚合）。
 * 覆盖：内置本机自动认领 / 字段归一到固定值 / 存量回环行原地升级 / 禁止用户添加回环 / 禁止删除本机。
 */
import { beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { userInfo } from "node:os";
import { ServiceError } from "@elysiax/core";
import { migrationsJournal } from "../../shared/migrations-journal";
import { ServerRepository } from "./servers.repository";
import { ServerService } from "./servers.service";
import { SshPool } from "./ssh-pool";
import { DockerRelay } from "./docker-relay";

function freshService() {
  const sqlite = new Database(":memory:");
  const db = drizzle({ client: sqlite });
  migrate(db, migrationsJournal);
  const repo = new ServerRepository(db);
  // 本机传输不碰 SSH 池/中继；真实例构造即可（无构造参数）
  return { sqlite, repo, svc: new ServerService(repo, new SshPool(), new DockerRelay()) };
}

let sqlite: Database;
let repo: ServerRepository;
let svc: ServerService;
beforeEach(() => {
  ({ sqlite, repo, svc } = freshService());
});

test("ensureLocal：无行时新建固定本机（127.0.0.1 / 端口 22 / 当前用户 / builtin）", async () => {
  const local = await svc.ensureLocal();
  expect(local.name).toBe("本机");
  expect(local.host).toBe("127.0.0.1");
  expect(local.port).toBe(22);
  expect(local.user).toBe(userInfo().username);
  expect(local.builtin).toBe(true);
  expect((await repo.list()).length).toBe(1);
});

test("ensureLocal：幂等，重复调用不新增行且字段归一", async () => {
  const first = await svc.ensureLocal();
  await repo.update(first.id, { name: "被改过的名字", user: "nobody", port: 2022 });
  const again = await svc.ensureLocal();
  expect(again.id).toBe(first.id);
  expect(again.name).toBe("本机");
  expect(again.user).toBe(userInfo().username);
  expect(again.port).toBe(22);
  expect((await repo.list()).length).toBe(1);
});

test("ensureLocal：默认形态的存量本机行原地升级（保留 id，画布卡/目标外键不断）", async () => {
  const me = userInfo().username;
  sqlite.run(
    `INSERT INTO servers (name, host, port, user, createdAt) VALUES ('本机测试', 'localhost', 22, '${me}', 0)`,
  );
  const legacy = (await repo.list())[0]!;
  const local = await svc.ensureLocal();
  expect(local.id).toBe(legacy.id);
  expect(local.name).toBe("本机");
  expect(local.port).toBe(22);
  expect(local.builtin).toBe(true);
});

test("ensureLocal：不回环就抢——用户自己的 SSH 隧道行（127.0.0.1:2222）原样保留", async () => {
  // 把隧道行升成 builtin 会改写 host/port/user 且钉死不可删，用户的部署目标会突然
  // 从「隧道那头的机器」变成「本机 daemon」
  sqlite.run(
    `INSERT INTO servers (name, host, port, user, authType, createdAt) VALUES ('隧道', '127.0.0.1', 2222, '${userInfo().username}', 'key', 0)`,
  );
  const tunnel = (await repo.list())[0]!;
  const local = await svc.ensureLocal();
  expect(local.id).not.toBe(tunnel.id);
  const kept = await repo.byId(tunnel.id);
  expect(kept).toMatchObject({ host: "127.0.0.1", port: 2222, name: "隧道", builtin: false });
});

test("create：回环地址不允许用户添加（大小写/空白/IPv6 方括号/127.0.0.2 都不能绕过）", () => {
  for (const host of ["localhost", "LOCALHOST", " localhost ", "127.0.0.1", "127.0.0.2", "[::1]", "::1", "app.localhost."]) {
    expect(() =>
      svc.create({ name: "假本机", host, port: 22, user: "root", authType: "key" }),
    ).toThrow(ServiceError);
  }
  expect(() =>
    svc.create({ name: "远程", host: "10.0.0.5", port: 22, user: "root", authType: "key" }),
  ).not.toThrow();
});

test("remove：内置本机不可删除", async () => {
  const local = await svc.ensureLocal();
  await expect(svc.remove(local.id)).rejects.toThrow(ServiceError);
  expect((await repo.list()).length).toBe(1);
});
