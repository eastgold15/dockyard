import { eq } from "drizzle-orm";
import type { Db } from "../../shared/db";
import { serverResources, type ServerResource } from "./schema";

export type NewResource = {
  serverId: number;
  name: string;
  dbType: ServerResource["dbType"];
  envKey: string;
};

export class ResourceRepository {
  constructor(private readonly db: Db) {}

  ofServer(serverId: number): Promise<ServerResource[]> {
    return this.db.select().from(serverResources).where(eq(serverResources.serverId, serverId)).orderBy(serverResources.id);
  }

  byId(id: number): Promise<ServerResource | undefined> {
    return this.db.select().from(serverResources).where(eq(serverResources.id, id)).limit(1).then((r) => r[0]);
  }

  async create(input: NewResource): Promise<ServerResource> {
    const [row] = await this.db.insert(serverResources).values(input).returning();
    return row!;
  }

  update(id: number, patch: Partial<Omit<ServerResource, "id">>) {
    return this.db.update(serverResources).set(patch).where(eq(serverResources.id, id));
  }

  remove(id: number) {
    return this.db.delete(serverResources).where(eq(serverResources.id, id));
  }
}
