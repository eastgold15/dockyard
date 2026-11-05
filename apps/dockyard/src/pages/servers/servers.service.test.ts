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
import {
  ServerService,
  applyMirrorsToServer,
  mergeRegistryMirrors,
  normalizeMirrors,
  parseMirrors,
  type CheckResult,
} from "./servers.service";
import type { ServerExecResult, ServerSftp, ServerTransport } from "./transport";
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

// ── 镜像源：纯函数 + 远端 apply 流程（fake transport 注入，不碰真实 SSH） ──

function fakeExecResult(stdout = "", code = 0): ServerExecResult {
  return { stdout, stderr: "", code, signal: null, coreDumped: null, errorMessage: null };
}

/** 按命令子串脚本化的 fake 传输通道；同时记录写入文件与全部执行命令供断言 */
function fakeTransport(script: {
  uid?: string;
  sudoOk?: boolean;
  daemonJson?: string;
  validateOk?: boolean;
  applyOk?: boolean;
}) {
  const writes: Record<string, string> = {};
  const execs: string[] = [];
  const exec = async (cmd: string): Promise<ServerExecResult> => {
    execs.push(cmd);
    if (cmd.startsWith("id -u")) return fakeExecResult(script.uid ?? "0");
    if (cmd.includes("sudo -n true")) return fakeExecResult("", script.sudoOk === false ? 1 : 0);
    if (cmd.includes("cat /etc/docker/daemon.json")) return fakeExecResult(script.daemonJson ?? "{}");
    if (cmd.includes("dockerd --validate")) return fakeExecResult("", script.validateOk === false ? 1 : 0);
    if (cmd.startsWith("set -e\nbackup=")) return fakeExecResult("", script.applyOk === false ? 1 : 0);
    return fakeExecResult();
  };
  const sftp = async (): Promise<ServerSftp> => ({
    async write(path, contents) {
      writes[path] = typeof contents === "string" ? contents : new TextDecoder().decode(contents);
    },
    async close() {},
  });
  return {
    execs,
    writes,
    exec,
    sftp,
  } satisfies ServerTransport & { execs: string[]; writes: Record<string, string> };
}

test("normalizeMirrors：补 https、去空行/尾斜杠/重复，拒绝非法协议", () => {
  expect(normalizeMirrors(" docker.1ms.run \n\n https://docker.1ms.run/\nhttps://docker.m.daocloud.io\n")).toEqual([
    "https://docker.1ms.run",
    "https://docker.m.daocloud.io",
  ]);
  expect(normalizeMirrors("   \n\n")).toEqual([]);
  expect(() => normalizeMirrors("ftp://docker.example.com")).toThrow(/只支持 http/);
});

test("parseMirrors：JSON 数组字符串 ↔ 列表；空/非法 JSON 当 []", () => {
  expect(parseMirrors({ registryMirrors: '["https://a","https://b"]' })).toEqual(["https://a", "https://b"]);
  expect(parseMirrors({ registryMirrors: "not-json" })).toEqual([]);
  expect(parseMirrors({ registryMirrors: null })).toEqual([]);
});

test("mergeRegistryMirrors：追加去重，保留远端原有配置项，空对象给默认镜像源", () => {
  const merged = mergeRegistryMirrors({ "storage-driver": "overlay2" }, ["https://a", "https://b", "https://a"]);
  const parsed = JSON.parse(merged);
  expect(parsed["registry-mirrors"]).toEqual(["https://a", "https://b"]);
  expect(parsed["storage-driver"]).toBe("overlay2");
  // 远端原有镜像源保留在 dockyard 配置之前
  expect(mergeRegistryMirrors({ "registry-mirrors": ["https://old"] }, ["https://new"])).toContain("https://old");
  expect(mergeRegistryMirrors(null, ["https://new"])).toContain('"registry-mirrors"');
});

test("applyMirrorsToServer：root 直写，install 落 /etc，重启 dockerd，返回最终列表", async () => {
  const t = fakeTransport({});
  const final = await applyMirrorsToServer(t, ["https://a"]);
  expect(final).toEqual(["https://a"]);
  const written = t.writes["/tmp/dockyard-daemon.json"];
  expect(JSON.parse(written!)).toEqual({ "registry-mirrors": ["https://a"] });
  // root 路径不带 sudo，且 apply 前先校验、覆盖前备份、失败可回滚
  const apply = t.execs.find((c) => c.startsWith("set -e\nbackup="))!;
  expect(apply).toContain("\ninstall ");
  expect(apply).toContain("cp -a /etc/docker/daemon.json");
  expect(apply).toContain("restart docker");
  expect(t.execs.some((c) => c.includes("dockerd --validate"))).toBe(true);
  expect(t.execs.some((c) => c.startsWith("sudo "))).toBe(false);
});

test("applyMirrorsToServer：非 root 有免密 sudo → 读取、校验、写入和重启都带 sudo", async () => {
  const t = fakeTransport({ uid: "1000", sudoOk: true });
  await applyMirrorsToServer(t, ["https://a"]);
  expect(t.execs.some((c) => c.includes("sudo cat /etc/docker/daemon.json"))).toBe(true);
  expect(t.execs.some((c) => c.includes("sudo dockerd --validate"))).toBe(true);
  const apply = t.execs.find((c) => c.startsWith("set -e\nbackup="))!;
  expect(apply).toContain("sudo install ");
  expect(apply).toContain("sudo systemctl restart docker");
});

test("applyMirrorsToServer：非 root 且无免密 sudo → 明确拒绝", async () => {
  const t = fakeTransport({ uid: "1000", sudoOk: false });
  await expect(applyMirrorsToServer(t, ["https://a"])).rejects.toThrow(/免密 sudo/);
});

test("applyMirrorsToServer：远端 daemon.json 非法 → 拒绝覆盖（不重启 docker）", async () => {
  const t = fakeTransport({ daemonJson: "{not json" });
  await expect(applyMirrorsToServer(t, ["https://a"])).rejects.toThrow(/不是合法 JSON/);
  expect(t.execs.some((c) => c.includes("restart docker"))).toBe(false);
});

test("applyMirrorsToServer：dockerd 校验失败不覆盖原配置、不重启", async () => {
  const t = fakeTransport({ validateOk: false });
  await expect(applyMirrorsToServer(t, ["https://a"])).rejects.toThrow(/配置校验失败/);
  expect(t.execs.some((c) => c.startsWith("set -e\nbackup="))).toBe(false);
});

test("applyMirrorsToServer：重启失败时报错，远端命令包含恢复备份并再次拉起", async () => {
  const t = fakeTransport({ applyOk: false });
  await expect(applyMirrorsToServer(t, ["https://a"])).rejects.toThrow(/自动恢复原配置/);
  const apply = t.execs.find((c) => c.startsWith("set -e\nbackup="))!;
  expect(apply).toContain('cp -a "$backup"');
  expect(apply).toContain("restart_docker || true");
});

test("applyMirrorsToServer：空列表直接拒绝", async () => {
  const t = fakeTransport({});
  await expect(applyMirrorsToServer(t, [])).rejects.toThrow(/为空/);
});

// configureMirrors：内嵌远程通道的重写子类（只测编排，不测真 SSH）
class FakeServerService extends ServerService {
  transportCalls = 0;
  constructor(transport: ServerTransport) {
    super(new ServerRepository(dbOfFake()), new SshPool(), new DockerRelay());
    this.fake = transport;
  }
  private fake: ServerTransport;
  override async transport() {
    this.transportCalls++;
    return this.fake;
  }
  override async check(): Promise<CheckResult> {
    return { ok: true, dockerVersion: "1.0" };
  }
}
function dbOfFake() {
  const sqlite = new Database(":memory:");
  const db = drizzle({ client: sqlite });
  migrate(db, migrationsJournal);
  return db;
}

test("configureMirrors：清空列表只保存不碰远端；非空则应用并回写状态", async () => {
  const t = fakeTransport({});
  const fsvc = new FakeServerService(t);
  const server = await fsvc.create({ name: "远", host: "10.0.0.5", port: 22, user: "root", authType: "key" });
  const clear = await fsvc.configureMirrors(server.id, "  \n ");
  expect(clear.applied).toBe(false);
  expect(fsvc.transportCalls).toBe(0);
  expect((await fsvc.byId(server.id))!.registryMirrors).toBeNull();

  const applied = await fsvc.configureMirrors(server.id, "https://a\nhttps://a");
  expect(applied.applied).toBe(true);
  expect(applied.mirrors).toEqual(["https://a"]);
  expect((await fsvc.byId(server.id))!.registryMirrors).toBe('["https://a"]');
  expect(fsvc.transportCalls).toBe(1);
});

test("configureMirrors：内置本机拒绝", async () => {
  const t = fakeTransport({});
  const fsvc = new FakeServerService(t);
  const local = await fsvc.ensureLocal();
  await expect(fsvc.configureMirrors(local.id, "https://a")).rejects.toThrow(/本机镜像源/);
});
