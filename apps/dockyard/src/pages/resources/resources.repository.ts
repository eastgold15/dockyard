import { eq } from "drizzle-orm";
import type { Db } from "../../shared/db";
import { serverResources, type ServerResource } from "./schema";

/** 建资源入参：字段与形状从 drizzle insert 类型派生，不手抄 */
export type NewResource = Pick<
  typeof serverResources.$inferInsert,
  "serverId" | "name" | "dbType" | "envKey"
>;

export class ResourceRepository {
  constructor(private readonly db: Db) {}

  async ofServer(serverId: number) {
    return this.db
      .select()
      .from(serverResources)
      .where(eq(serverResources.serverId, serverId))
      .orderBy(serverResources.id);
  }

  async byId(id: number) {
    return this.db
      .select()
      .from(serverResources)
      .where(eq(serverResources.id, id))
      .limit(1)
      .then((r) => r[0]);
  }

  async create(input: NewResource) {
    const [row] = await this.db
      .insert(serverResources)
      .values(input)
      .returning();
    return row!;
  }

  async update(id: number, patch: Partial<Omit<ServerResource, "id">>) {
    return this.db
      .update(serverResources)
      .set(patch)
      .where(eq(serverResources.id, id));
  }

  async remove(id: number) {
    return this.db.delete(serverResources).where(eq(serverResources.id, id));
  }
}
