import { t } from "elysia";
import { defineRoutes, type ProjectsServices } from "../../../.elysiax";
import { loadConfig, saveConfig } from "./config";
import type {
  NewProjectData,
  ProjectListModel,
  ScanConfig,
} from "./projects.types";

/** DI 视图：键与类型来自 codegen 的 ProjectsServices（= 本模块 provides ∪ 直接 deps） */
type Di = { get<K extends keyof ProjectsServices>(k: K): ProjectsServices[K] };

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
export default defineRoutes<ProjectsServices>()
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
  // 新建项目弹窗：仓库列表由 projectService 组装（GitHub 失败降级为空列表）
  .get("/new", async ({ di }): Promise<NewProjectData> =>
    di.get("projectService").newProjectData(),
  )
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
