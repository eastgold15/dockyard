// 来源形态判定（纯函数）：部署分派与画布快照/抽屉共用同一口口径，
// 「local 项目也带 repoUrl」这种组合必须判 local，否则客户端会把传输段误标成跳过。
import { expect, test } from "bun:test";
import { sourceTypeOf } from "./deploy.service";

test("项目显式 sourceType 优先，不看 repoUrl/localPath", () => {
  // 克隆到本地后导入：local + repoUrl
  expect(sourceTypeOf({ repoUrl: "https://github.com/x/y" }, { sourceType: "local", localPath: "/tmp/x" })).toBe("local");
  // 纯远端仓库：github 即便本机刚好有同名目录
  expect(sourceTypeOf({ repoUrl: "https://github.com/x/y" }, { sourceType: "github", localPath: "/tmp/x" })).toBe("github");
});

test("旧数据 sourceType=null：按 localPath/repoUrl 推断", () => {
  expect(sourceTypeOf({ repoUrl: null }, { sourceType: null, localPath: "/tmp/x" })).toBe("local");
  expect(sourceTypeOf({ repoUrl: "https://github.com/x/y" }, { sourceType: null, localPath: "/tmp/x" })).toBe("github");
  expect(sourceTypeOf({ repoUrl: "https://github.com/x/y" }, { sourceType: null, localPath: null })).toBe("github");
});

test("没有项目归属：无从判 local（缺 localPath）→ 一律 github，部署时由 service 报错", () => {
  // 推断 local 的前提是项目带 localPath；未关联项目时没有这个凭据，不能凭空判 local
  expect(sourceTypeOf({ repoUrl: "https://github.com/x/y" }, undefined)).toBe("github");
  expect(sourceTypeOf({ repoUrl: null }, null)).toBe("github");
});
