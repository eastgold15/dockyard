// projects 原子的插座：对外承诺的全部契约。
export { projects } from "./schema";
export type { Project } from "./schema";
export { ProjectService } from "./projects.service";

/** Eden Treaty 的 API 类型出口（同原子 client 引用；壳由 codegen HTMLBundle 服务） */
import type projectActions from "./projects.actions";
export type ProjectApi = typeof projectActions;
