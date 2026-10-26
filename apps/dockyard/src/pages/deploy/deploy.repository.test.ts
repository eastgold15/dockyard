/**
 * DeployRepository 单测：内存 sqlite 跑全部真迁移（与 shared/db.ts 同一份聚合），
 * 验证日志分块（appendLogChunk/logTextOf）与历史清理（pruneRuns 级联删 chunks）。
 */
import { beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { migrationsJournal } from "../../shared/migrations-journal";
import { DeployRepository } from "./deploy.repository";
import { deployArtifacts, deployLogChunks } from "./schema";
import { eq } from "drizzle-orm";

function freshRepo() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON;"); // pruneRuns 的 chunks 清理靠 FK cascade，必须开
  const db = drizzle({ client: sqlite });
  migrate(db, migrationsJournal); // 与生产同一份聚合（shared/migrations-journal.ts）
  // FK 链：deploy_targets.nodeId → canvas_nodes → servers，造最小上游行
  // （裸 SQL 绕不过 drizzle 的 $defaultFn，createdAt 手工给）
  sqlite.run("INSERT INTO servers (name, host, user, createdAt) VALUES ('s1', '127.0.0.1', 'root', 0)");
  sqlite.run("INSERT INTO canvas_nodes (serverId) VALUES (1)");
  return new DeployRepository(db);
}

let repo: DeployRepository;
let targetId: number;
beforeEach(async () => {
  repo = freshRepo();
  targetId = (await repo.createTarget({ nodeId: 1, kind: "app", name: "t1" })).id;
});

test("appendLogChunk：seq 递增、logTextOf 按序拼接", async () => {
  const run = await repo.createDeployment(targetId);
  await repo.appendLogChunk(run.id, "第一行");
  await repo.appendLogChunk(run.id, "第二行");
  await repo.appendLogChunk(run.id, "第三行");
  expect(await repo.logTextOf(run.id)).toBe("第一行\n第二行\n第三行");
});

test("logTextOf：chunks 为空时兜底旧 logText（存量防御）", async () => {
  const run = await repo.createDeployment(targetId);
  await repo.updateDeployment(run.id, { logText: "旧格式日志" });
  expect(await repo.logTextOf(run.id)).toBe("旧格式日志");
});

test("createDeployment：trigger/rollbackOf 血缘落库", async () => {
  const base = await repo.createDeployment(targetId);
  const rb = await repo.createDeployment(targetId, { trigger: "rollback", rollbackOf: base.id });
  expect(rb.trigger).toBe("rollback");
  expect(rb.rollbackOf).toBe(base.id);
  expect(base.trigger).toBe("ui"); // 默认值
});

test("pruneRuns：只留最近 keep 条，chunks 级联清", async () => {
  // 造 5 条 run，各带 2 行 chunk
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    const run = await repo.createDeployment(targetId);
    await repo.appendLogChunk(run.id, `run${run.id}-a`);
    await repo.appendLogChunk(run.id, `run${run.id}-b`);
    ids.push(run.id);
  }
  await repo.pruneRuns(targetId, 2);
  const rest = await repo.deploymentsOfTarget(targetId, 100);
  expect(rest.map((r) => r.id)).toEqual([ids[4]!, ids[3]!]); // 新→旧
  // 被清 run 的 chunks 必须级联删除
  const db = (repo as unknown as { db: ReturnType<typeof drizzle> }).db;
  const orphanChunks = await db.select().from(deployLogChunks).where(eq(deployLogChunks.runId, ids[0]!));
  expect(orphanChunks.length).toBe(0);
  // 保留的 run 日志完好
  expect(await repo.logTextOf(ids[4]!)).toBe(`run${ids[4]}-a\nrun${ids[4]}-b`);
});

test("artifacts：创建后历史联查透出 rollbackable（仅成功且有产物的 run）", async () => {
  const ok = await repo.createDeployment(targetId);
  await repo.updateDeployment(ok.id, { status: "success" });
  const artifact = await repo.createArtifact({
    targetId, runId: ok.id, project: "dockyard-1",
    imageTags: { web: "dockyard-1-web:run-1" }, snapshotJson: "enc1:xxx", sha: "abc123",
  });
  await repo.updateDeployment(ok.id, { artifactId: artifact.id });
  const failed = await repo.createDeployment(targetId);
  await repo.updateDeployment(failed.id, { status: "failed" });

  const rows = await repo.deploymentsOfTarget(targetId);
  expect(rows.find((r) => r.id === ok.id)?.rollbackable).toBe(true);
  expect(rows.find((r) => r.id === failed.id)?.rollbackable).toBe(false);
  expect((await repo.artifactById(artifact.id))?.sha).toBe("abc123");
});

test("pruneRuns：产物连带 GC——产出 run 被清且无存活引用才删，回滚引用保命", async () => {
  // r1 产出 A1；r2 是回滚 run，引用 A1
  const r1 = await repo.createDeployment(targetId);
  const a1 = await repo.createArtifact({ targetId, runId: r1.id, snapshotJson: "enc1:a" });
  await repo.updateDeployment(r1.id, { artifactId: a1.id });
  const r2 = await repo.createDeployment(targetId, { trigger: "rollback", rollbackOf: r1.id, artifactId: a1.id });
  // r3 产出 A2（无人引用）；r4 是最新存活
  const r3 = await repo.createDeployment(targetId);
  const a2 = await repo.createArtifact({ targetId, runId: r3.id, snapshotJson: "enc1:b" });
  const r4 = await repo.createDeployment(targetId);

  await repo.pruneRuns(targetId, 2); // 存活：r4、r3（r2 引用 A1 但自身被清）
  const db = (repo as unknown as { db: ReturnType<typeof drizzle> }).db;
  const rest = await db.select().from(deployArtifacts).where(eq(deployArtifacts.targetId, targetId));
  // A1：产出 run r1 被清 + 引用它的 r2 也被清 → 删；A2：产出 run r3 存活 → 留
  expect(rest.map((a) => a.id)).toEqual([a2.id]);
  expect(r2.artifactId).toBe(a1.id); // 血缘字段在创建时落库
});
