import { eq } from "drizzle-orm";
import type { Db } from "@/shared/db";
import { canvasNodes } from "@/pages/canvas/canvas.socket";
import { deployTargets } from "@/pages/deploy/deploy.socket";
import { domains, type Domain } from "./schema";

/** 域名行归 edge 上下文（语义 = 路由 + 证书）；跨表 join 只为定位「这台服务器上的域名」 */
export class EdgeRepository {
  constructor(private readonly db: Db) {}

  async domainsOfTarget(targetId: number) {
    return this.db.select().from(domains).where(eq(domains.targetId, targetId));
  }

  async domainById(id: number) {
    return this.db
      .select()
      .from(domains)
      .where(eq(domains.id, id))
      .limit(1)
      .then((r) => r[0]);
  }

  async domainByHostname(hostname: string) {
    return this.db
      .select()
      .from(domains)
      .where(eq(domains.hostname, hostname))
      .limit(1)
      .then((r) => r[0]);
  }

  async addDomain(
    input: Omit<typeof domains.$inferInsert, "id" | "createdAt">,
  ) {
    const [row] = await this.db.insert(domains).values(input).returning();
    return row!;
  }

  async updateDomain(id: number, patch: Partial<Domain>) {
    return this.db.update(domains).set(patch).where(eq(domains.id, id));
  }

  async removeDomain(id: number) {
    return this.db.delete(domains).where(eq(domains.id, id));
  }

  /** 只读探针：target 的 kind/name（域名抢占/绑定校验的报错信息用） */
  async targetBrief(
    id: number,
  ) {
    const rows = await this.db
      .select({ kind: deployTargets.kind, name: deployTargets.name })
      .from(deployTargets)
      .where(eq(deployTargets.id, id))
      .limit(1);
    return rows[0];
  }

  /** 一台服务器（target → node → server）上的全部域名——edge 路由全量对账用 */
  async domainsOfServer(serverId: number) {
    const rows = await this.db
      .select({ d: domains, nodeServerId: canvasNodes.serverId })
      .from(domains)
      .innerJoin(deployTargets, eq(domains.targetId, deployTargets.id))
      .innerJoin(canvasNodes, eq(deployTargets.nodeId, canvasNodes.id));
    return rows.filter((r) => r.nodeServerId === serverId).map((r) => r.d);
  }
}
