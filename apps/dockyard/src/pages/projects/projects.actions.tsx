import { t } from "elysia";
import { defineRoutes } from "../../../.elysiax";
import { loadConfig, saveConfig } from "./config";
import { listModel, ProjectList } from "./projects.partials";

const model = (di: any) =>
  listModel({ project: di.get("projectService"), local: di.get("localService") });

/** 写端点（7.2 三态）：成功返回刷新片段（同源）+ OOB 关弹窗；失败 400 文本 */
export default defineRoutes()
  .post("/config", { body: t.Object({ scanDirs: t.String() }) }, async ({ di, body }) => {
    const cfg = await loadConfig();
    await saveConfig({
      ...cfg,
      scanDirs: body.scanDirs.split("\n").map((s) => s.trim()).filter(Boolean),
    });
    return (
      <>
        <ProjectList {...await model(di)} />
        <div id="modal-root" hx-swap-oob="innerHTML" />
      </>
    );
  })
  // 用编辑器 / lazygit 打开本地目录（编辑器用过即设为默认）
  .post(
    "/open",
    { body: t.Object({ path: t.String({ minLength: 1 }), tool: t.String({ minLength: 1 }) }) },
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
    { body: t.Object({ name: t.String({ minLength: 1 }), repoUrl: t.Optional(t.String()) }) },
    async ({ di, body }) => {
      await di.get("projectService").create(body.name, body.repoUrl);
      // OOB 清空 #modal-root 关弹窗，主体刷新项目列表
      return (
        <>
          <ProjectList {...await model(di)} />
          <div id="modal-root" hx-swap-oob="innerHTML" />
        </>
      );
    },
  )
  .delete("/:id", { params: t.Object({ id: t.Number() }) }, async ({ di, params }) => {
    await di.get("projectService").remove(params.id);
    return <ProjectList {...await model(di)} />;
  });
