import { definePage } from "@elysiax/core";
import { listModel, ProjectList } from "./projects.partials";

/** GET /projects —— 项目列表页（L1 原子：可寻址、自包含、不可再分） */
export default definePage(async ({ di }) => {
  const model = await listModel({
    project: di.get("projectService"),
    local: di.get("localService"),
  });
  return { title: "项目", content: <ProjectList {...model} /> };
});
