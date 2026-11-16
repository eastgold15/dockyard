import { eq } from "drizzle-orm";
import type { Db } from "../../shared/db";
import { servers, type Server } from "./schema";

/** 建服务器入参：字段与形状从 drizzle insert 类型派生，不手抄 */
export type NewServer = Pick<
  typeof servers.$inferInsert,
  | "name"
  | "host"
  | "port"
  | "user"
  | "authType"
  | "keyPath"
  | "password"
  | "builtin"
  | "registryMirrors"
>;

export class ServerRepository {
  constructor(private readonly db: Db) {}

  list(): Promise<Server[]> {
    return this.db.select().from(servers).orderBy(servers.id);
  }

  byId(id: number): Promise<Server | undefined> {
    return this.db
      .select()
      .from(servers)
      .where(eq(servers.id, id))
      .limit(1)
      .then((r) => r[0]);
  }

  async create(input: NewServer): Promise<Server> {
    const [row] = await this.db.insert(servers).values(input).returning();
    return row!;
  }

  update(id: number, patch: Partial<Omit<Server, "id">>) {
    return this.db.update(servers).set(patch).where(eq(servers.id, id));
  }

  remove(id: number) {
    return this.db.delete(servers).where(eq(servers.id, id));
  }
}
