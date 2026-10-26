import { eq } from "drizzle-orm";
import type { Db } from "../../shared/db";
import { projects, type Project } from "./schema";

export class ProjectRepository {
  constructor(private readonly db: Db) { }

  list(): Promise<Project[]> {
    return this.db.select().from(projects).orderBy(projects.id);
  }

  byId(id: number): Promise<Project | undefined> {
    return this.db.select().from(projects).where(eq(projects.id, id)).limit(1).then((r) => r[0]);
  }

  byLocalPath(localPath: string): Promise<Project | undefined> {
    return this.db.select().from(projects).where(eq(projects.localPath, localPath)).limit(1).then((r) => r[0]);
  }

  async create(name: string, repoUrl?: string, localPath?: string, sourceType?: "github" | "local"): Promise<Project> {
    const base =
      name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9一-鿿]+/g, "-")
        .replace(/^-|-$/g, "") || `project-${Date.now()}`;
    // slug 唯一：重名目录（不同扫描目录下同名项目）依次加后缀
    let slug = base;
    for (let i = 2; await this.bySlug(slug); i++) slug = `${base}-${i}`;
    const [row] = await this.db
      .insert(projects)
      .values({ name, slug, repoUrl: repoUrl || null, localPath: localPath || null, sourceType: sourceType ?? null })
      .returning();
    return row!;
  }

  private bySlug(slug: string): Promise<Project | undefined> {
    return this.db.select().from(projects).where(eq(projects.slug, slug)).limit(1).then((r) => r[0]);
  }

  remove(id: number) {
    return this.db.delete(projects).where(eq(projects.id, id));
  }
}
