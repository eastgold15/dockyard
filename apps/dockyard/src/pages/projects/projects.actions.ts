import { t } from "elysia";
import { defineRoutes, type ServiceMap } from "../../../.elysiax";
import { loadConfig, saveConfig } from "./config";
import type {
  NewProjectData,
  ProjectListModel,
  ScanConfig,
} from "./projects.types";

/** DI 容器视图：键与返回类型全部来自 codegen 的 ServiceMap，不重抄 */
type Di = { get<K extends keyof ServiceMap>(k: K): ServiceMap[K] };

/** 列表视图模型：本地扫描结果（磁盘为准）+ 未检出的 GitHub 项目空间 */
const model = async (di: Di): Promise<ProjectListModel> => {
  const project = di.get("projectService");
  const local = di.get("localService");
  const [projects, toolchain] = await Promise.all([
    project.list(),
    local.toolchain(),
  ]);
  const scanned = await local.scan(projects);
  const localPaths = new Set(scanned.map((p) => p.path));
  return {
    local: scanned,
    remote: projects.filter(
      (p) => !p.localPath || !localPaths.has(p.localPath),
    ),
    ...toolchain,
  };
};

/** projects 的 JSON API（Solid 页；壳由 codegen HTMLBundle 服务）。 */
export default defineRoutes()
  .get("/", async ({ di }): Promise<ProjectListModel> => model(di))
  // 扫描目录配置：GET 取当前配置，POST 保存并返回刷新后的列表
  .get("/config", async (): Promise<ScanConfig> => {
    const { scanDirs } = await loadConfig();
    return { scanDirs };
  })
  .post(
    "/config",
    { body: t.Object({ scanDirs: t.String() }) },
    async ({ di, body }) => {
      const cfg = await loadConfig();
      await saveConfig({
        ...cfg,
        scanDirs: body.scanDirs
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      return model(di);
    },
  )
  // 新建项目弹窗：gh CLI 列仓库（未登录时降级为空列表，仍可手填/跳过）
  .get("/new", async ({ di }): Promise<NewProjectData> => {
    try {
      return { repos: await di.get("githubService").listRepos() };
    } catch (e) {
      return {
        repos: [],
        error: `仓库列表拉取失败（${(e as Error).message}），可跳过绑定`,
      };
    }
  })
  // 用编辑器 / lazygit 打开本地目录（编辑器用过即设为默认）
  .post(
    "/open",
    {
      body: t.Object({
        path: t.String({ minLength: 1 }),
        tool: t.String({ minLength: 1 }),
      }),
    },
    // 预期错误（未装 lazygit / 终端）由 localService 抛 ServiceError，框架统一回显
    async ({ di, body, set }) => {
      const local = di.get("localService");
      if (body.tool === "lazygit") await local.openLazygit(body.path);
      else await local.openEditor(body.path, body.tool);
      set.status = 204;
    },
  )
  .post(
    "/",
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        repoUrl: t.Optional(t.String()),
      }),
    },
    async ({ di, body }) => {
      await di.get("projectService").create(body.name, body.repoUrl);
      return model(di);
    },
  )
  .delete(
    "/:id",
    { params: t.Object({ id: t.Number() }) },
    async ({ di, params }) => {
      await di.get("projectService").remove(params.id);
      return model(di);
    },
  );
