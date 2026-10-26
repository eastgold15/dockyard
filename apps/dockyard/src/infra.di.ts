import { defineModule } from "@elysiax/core";
import { db } from "./shared/db";
import { appPaths } from "./shared/paths";

// 基础设施：最先装配
export default defineModule({
  provides: {
    db: { value: db },
    appPaths: { value: appPaths },
  },
});
