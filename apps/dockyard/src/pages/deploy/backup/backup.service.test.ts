/**
 * 备份/恢复命令回归点（这条链路出过三个「假成功」缺陷）：
 * - 备份不能写成 docker exec | gzip | base64：管道退出码只取最后一段，
 *   dump 失败也会产出空备份。命令必须逐段判错 + 非空 + gzip -t 自检。
 * - 恢复必须先 gzip -t（半截/损坏的备份不能灌进库），且 postgres 用 ON_ERROR_STOP=0
 *   （--clean 的 DROP ROLE 以被 dump 的角色连接时必然报错，不能当成恢复失败）。
 * - 容器名/路径拼进宿主 shell 前必须单引号转义（名字来自用户输入）。
 */
import { expect, test } from "bun:test";
import {
  backupHostCommand,
  countRestoreWarnings,
  dumpCommandFor,
  RESTORE_SUPPORT,
  restoreHostCommand,
  shq,
} from "./backup.service";

test("dumpCommandFor：postgres 带 --clean --if-exists，其余引擎不变", () => {
  expect(dumpCommandFor("postgres")).toContain("--clean --if-exists");
  expect(dumpCommandFor("mysql")).toContain("mysqldump --all-databases");
  expect(dumpCommandFor("mongo")).toContain("mongodump --archive");
  expect(dumpCommandFor("redis")).toContain("redis-cli save");
  // 未知引擎回落 postgres（与历史行为一致）
  expect(dumpCommandFor("sqlite")).toBe(dumpCommandFor("postgres"));
});

test("backupHostCommand：逐段判错、非空校验、gzip 自检，不再用管道吞掉 dump 失败", () => {
  const cmd = backupHostCommand("postgres", "dockyard-7-db");
  expect(cmd).toContain("docker exec 'dockyard-7-db' sh -c");
  expect(cmd).toContain('[ -s "$tmp" ]');
  expect(cmd).toContain("gzip -t");
  expect(cmd).toContain("base64 -w0 <");
  // dump 的退出码必须被显式检查（管道写法正是缺陷来源）
  expect(cmd).toContain("|| exit $?");
});

test("RESTORE_SUPPORT：postgres/mongo 可恢复，mysql/redis 只能手动", () => {
  expect(RESTORE_SUPPORT.postgres).toBe(true);
  expect(RESTORE_SUPPORT.mongo).toBe(true);
  expect(RESTORE_SUPPORT.mysql).toBe(false);
  expect(RESTORE_SUPPORT.redis).toBe(false);
});

test("restoreHostCommand：先 gzip -t 校验，再灌容器；postgres 容忍语句级错误", () => {
  const cmd = restoreHostCommand({
    dbType: "postgres",
    file: "/home/me/dockyard/restore/7/2026.sql.gz",
    container: "dockyard-7-db",
  });
  expect(cmd).toContain("gzip -t '/home/me/dockyard/restore/7/2026.sql.gz'");
  expect(cmd).toContain("gunzip -c '/home/me/dockyard/restore/7/2026.sql.gz' | docker exec -i 'dockyard-7-db'");
  expect(cmd).toContain("ON_ERROR_STOP=0");
  const mongo = restoreHostCommand({ dbType: "mongo", file: "/x.dump.gz", container: "c" });
  expect(mongo).toContain("mongorestore --archive --drop");
  expect(mongo).toContain("$MONGO_INITDB_ROOT_PASSWORD");
});

test("restoreHostCommand：不支持的引擎抛 ServiceError", () => {
  expect(() => restoreHostCommand({ dbType: "mysql", file: "/x.sql.gz", container: "c" })).toThrow(
    /暂不支持自动恢复/,
  );
  expect(() => restoreHostCommand({ dbType: "redis", file: "/x.dump.gz", container: "c" })).toThrow(
    /暂不支持自动恢复/,
  );
});

test("shq：单引号转义（容器名注入防护）", () => {
  expect(shq("dockyard-7-db")).toBe("'dockyard-7-db'");
  expect(shq("a'b")).toBe("'a'\\''b'");
  expect(shq("x; rm -rf /")).toBe("'x; rm -rf /'");
});

test("countRestoreWarnings：只数非预期的语句级 ERROR/FATAL", () => {
  const out = [
    "SET",
    "ERROR:  role \"postgres\" already exists",
    "ERROR:  current user cannot be dropped",
    "FATAL:  password authentication failed",
    "ERROR:  relation \"t\" already exists",
    "CREATE DATABASE",
  ].join("\n");
  // 前两条是重放整库 dump 的幂等噪声（当前连接用户自身的角色），不能算进告警
  expect(countRestoreWarnings(out)).toBe(2);
  expect(countRestoreWarnings("")).toBe(0);
  // 真·干净恢复（只回显命令）不产生告警
  expect(countRestoreWarnings("SET\nDROP DATABASE\nCREATE DATABASE\n")).toBe(0);
});
