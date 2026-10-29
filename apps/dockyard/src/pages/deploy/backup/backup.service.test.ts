/**
 * 备份/恢复命令回归点：
 * - postgres dump 必须 --clean --if-exists（恢复才对已有数据的实例可重放）
 * - 恢复管道：宿主 gunzip → docker exec -i，凭据在容器内展开（docker exec 不展开宿主变量）
 * - 不支持自动恢复的引擎必须明确拒绝，而不是产出半吊子命令
 */
import { expect, test } from "bun:test";
import { dumpCommandFor, RESTORE_SUPPORT, restorePipeCommand } from "./backup.service";

test("dumpCommandFor：postgres 带 --clean --if-exists，其余引擎不变", () => {
  expect(dumpCommandFor("postgres")).toContain("--clean --if-exists");
  expect(dumpCommandFor("mysql")).toContain("mysqldump --all-databases");
  expect(dumpCommandFor("mongo")).toContain("mongodump --archive");
  expect(dumpCommandFor("redis")).toContain("redis-cli save");
  // 未知引擎回落 postgres（与历史行为一致）
  expect(dumpCommandFor("sqlite")).toBe(dumpCommandFor("postgres"));
});

test("RESTORE_SUPPORT：postgres/mongo 可恢复，mysql/redis 只能手动", () => {
  expect(RESTORE_SUPPORT.postgres).toBe(true);
  expect(RESTORE_SUPPORT.mongo).toBe(true);
  expect(RESTORE_SUPPORT.mysql).toBe(false);
  expect(RESTORE_SUPPORT.redis).toBe(false);
});

test("restorePipeCommand：gunzip 管道进容器，环境变量在容器内展开", () => {
  const cmd = restorePipeCommand({
    dbType: "postgres",
    file: "/home/me/dockyard/restore/7/2026.sql.gz",
    container: "dockyard-7-db",
  });
  expect(cmd).toBe(
    'gunzip -c "/home/me/dockyard/restore/7/2026.sql.gz" | docker exec -i dockyard-7-db ' +
      `sh -c 'psql -U "\${POSTGRES_USER:-postgres}" -d postgres -v ON_ERROR_STOP=1'`,
  );
  const mongo = restorePipeCommand({ dbType: "mongo", file: "/x.dump.gz", container: "c" });
  expect(mongo).toContain("mongorestore --archive --drop");
  expect(mongo).toContain("$MONGO_INITDB_ROOT_PASSWORD");
});

test("restorePipeCommand：不支持的引擎抛 ServiceError", () => {
  expect(() => restorePipeCommand({ dbType: "mysql", file: "/x.sql.gz", container: "c" })).toThrow(
    /暂不支持自动恢复/,
  );
  expect(() => restorePipeCommand({ dbType: "redis", file: "/x.dump.gz", container: "c" })).toThrow(
    /暂不支持自动恢复/,
  );
});
