import { and, asc, desc, eq, max, notInArray } from "drizzle-orm";
import type { Db } from "../../shared/db";
import { deployLogChunks, deployments, deployTargets, type Deployment, type DeployTarget } from "./schema";

export type NewTarget = Omit<typeof deployTargets.$inferInsert, "id" | "createdAt">;

export class DeployRepository {
  constructor(private readonly db: Db) {}

  targetsOfNode(nodeId: number): Promise<DeployTarget[]> {
    return this.db.select().from(deployTargets).where(eq(deployTargets.nodeId, nodeId));
  }

  targetById(id: number): Promise<DeployTarget | undefined> {
    return this.db.select().from(deployTargets).where(eq(deployTargets.id, id)).limit(1).then((r) => r[0]);
  }

  /** 项目空间内所有 db 目标（依赖连线/连接串引用的候选集；世界地图后归属直接在 target 上） */
  dbTargetsOfProject(projectId: number): Promise<DeployTarget[]> {
    return this.db
      .select()
      .from(deployTargets)
      .where(and(eq(deployTargets.projectId, projectId), eq(deployTargets.kind, "db")));
  }

  appTargets(): Promise<DeployTarget[]> {
    return this.db.select().from(deployTargets).where(eq(deployTargets.kind, "app"));
  }

  async createTarget(input: NewTarget): Promise<DeployTarget> {
    const [row] = await this.db.insert(deployTargets).values(input).returning();
    return row!;
  }

  updateTarget(id: number, patch: Partial<DeployTarget>) {
    return this.db.update(deployTargets).set(patch).where(eq(deployTargets.id, id));
  }

  childrenOf(instanceId: number): Promise<DeployTarget[]> {
    return this.db.select().from(deployTargets).where(eq(deployTargets.instanceOf, instanceId));
  }

  removeTarget(id: number) {
    return this.db.delete(deployTargets).where(eq(deployTargets.id, id));
  }

  /** 删除分组前：组内目标回落到服务器卡（不连带删部署） */
  clearGroup(groupId: number) {
    return this.db.update(deployTargets).set({ groupId: null }).where(eq(deployTargets.groupId, groupId));
  }

  async createDeployment(
    targetId: number,
    extra?: { trigger?: Deployment["trigger"]; rollbackOf?: number },
  ): Promise<Deployment> {
    const [row] = await this.db.insert(deployments).values({ targetId, ...extra }).returning();
    return row!;
  }

  /** 上次成功部署（逻辑库幂等判断用；不含本次 in-flight 行） */
  lastSuccessfulDeployment(targetId: number): Promise<Deployment | undefined> {
    return this.db
      .select().from(deployments)
      .where(and(eq(deployments.targetId, targetId), eq(deployments.status, "success")))
      .orderBy(desc(deployments.id)).limit(1)
      .then((r) => r[0]);
  }

  /** 部署历史（新→旧，服务抽屉 Deployments Tab） */
  deploymentsOfTarget(targetId: number, limit = 10): Promise<Deployment[]> {
    return this.db.select().from(deployments)
      .where(eq(deployments.targetId, targetId))
      .orderBy(desc(deployments.id)).limit(limit);
  }

  deploymentById(id: number): Promise<Deployment | undefined> {
    return this.db.select().from(deployments).where(eq(deployments.id, id)).limit(1).then((r) => r[0]);
  }

  latestDeployment(targetId: number): Promise<Deployment | undefined> {
    return this.db
      .select().from(deployments)
      .where(eq(deployments.targetId, targetId))
      .orderBy(desc(deployments.id)).limit(1)
      .then((r) => r[0]);
  }

  updateDeployment(id: number, patch: Partial<Deployment>) {
    return this.db.update(deployments).set(patch).where(eq(deployments.id, id));
  }

  /**
   * 日志分块追加（替代 logText 读改写——长构建日志数 MB，全列重写既慢又放大 WAL）。
   * seq 取库内 MAX+1：pipeline 生命周期内可能多段写（execLongRemote 回调），
   * 内存计数器在进程重启/多写者场景不可靠，一次廉价查询换正确性。
   */
  async appendLogChunk(runId: number, text: string) {
    const row = await this.db
      .select({ maxSeq: max(deployLogChunks.seq) })
      .from(deployLogChunks)
      .where(eq(deployLogChunks.runId, runId))
      .then((r) => r[0]);
    await this.db.insert(deployLogChunks).values({
      runId,
      seq: (row?.maxSeq ?? -1) + 1,
      text,
      ts: Date.now(),
    });
  }

  /** 整段日志（chunks 按 seq 拼接；chunks 为空时兜底旧 logText——存量行迁移已回填，兜底是防御） */
  async logTextOf(runId: number): Promise<string> {
    const chunks = await this.db
      .select({ text: deployLogChunks.text })
      .from(deployLogChunks)
      .where(eq(deployLogChunks.runId, runId))
      .orderBy(asc(deployLogChunks.seq));
    if (chunks.length) return chunks.map((c) => c.text).join("\n");
    const row = await this.db
      .select({ logText: deployments.logText })
      .from(deployments)
      .where(eq(deployments.id, runId))
      .limit(1)
      .then((r) => r[0]);
    return row?.logText ?? "";
  }

  /** 历史清理：每个 target 只留最近 keep 条 run（chunks 靠 ON DELETE CASCADE 连带清） */
  async pruneRuns(targetId: number, keep: number) {
    const kept = await this.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.targetId, targetId))
      .orderBy(desc(deployments.id))
      .limit(keep);
    if (kept.length === 0) return;
    await this.db
      .delete(deployments)
      .where(and(eq(deployments.targetId, targetId), notInArray(deployments.id, kept.map((k) => k.id))));
  }
}
