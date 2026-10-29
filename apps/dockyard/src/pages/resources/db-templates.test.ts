/**
 * db 模板项目名回归点：
 * - 项目名必须由模板顶层 name: 定死（目录名会随 provision/回滚目录漂移）
 * - 无所有权 = 裸模板，不渲染 name、不返回 project（调用方不得 -p）
 */
import { expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { assertSafeLogicalName, assertSafeResourceName, dbCompose } from "./db-templates";

type ComposeDoc = {
  name?: string;
  services: Record<string, { container_name?: string; labels?: Record<string, string> }>;
};

test("dbCompose：部署目标渲染 name 与 container_name，并返回 project", () => {
  const rendered = dbCompose("postgres", "db", { targetId: 7 });
  const doc = parseYaml(rendered.compose) as ComposeDoc;
  expect(doc.name).toBe("dockyard-7");
  expect(doc.services.db!.container_name).toBe("dockyard-7-db");
  expect(doc.services.db!.labels?.["dockyard.target-id"]).toBe("7");
  expect(rendered.project).toBe("dockyard-7");
});

test("dbCompose：共享资源渲染 dockyard-res-<id> 项目名", () => {
  const rendered = dbCompose("redis", "cache", { resourceId: 3 });
  const doc = parseYaml(rendered.compose) as ComposeDoc;
  expect(doc.name).toBe("dockyard-res-3");
  expect(doc.services.cache!.container_name).toBe("dockyard-res-3-cache");
  expect(rendered.project).toBe("dockyard-res-3");
});

test("assertSafeResourceName：会拼进 shell/容器名/卷名的输入只允许安全字符", () => {
  for (const ok of ["db", "my-db", "my_db", "a.b", "pg1"]) expect(() => assertSafeResourceName(ok)).not.toThrow();
  for (const bad of ["my pg", "a;rm -rf /", "-lead", "$(id)", "库", ""]) {
    expect(() => assertSafeResourceName(bad)).toThrow(/名称只允许/);
  }
});

test("dbCompose：裸模板不渲染 name、不返回 project", () => {
  const rendered = dbCompose("mysql", "bare");
  const doc = parseYaml(rendered.compose) as ComposeDoc;
  expect(doc.name).toBeUndefined();
  expect(doc.services.bare!.container_name).toBeUndefined();
  expect(rendered.project).toBeUndefined();
});

test("assertSafeLogicalName：逻辑库名会进 SQL 与连接串，连字符/空格/引号一律拒", () => {
  for (const ok of ["app", "app_db", "_tmp", "A1"]) expect(() => assertSafeLogicalName(ok)).not.toThrow();
  for (const bad of ["my-pg", "a b", "a;drop", "1abc", "库", ""]) {
    expect(() => assertSafeLogicalName(bad)).toThrow(/逻辑库名/);
  }
});

test("dbCompose：渲染器自身拒绝非法名称（调用方漏校验也不放行）", () => {
  expect(() => dbCompose("postgres", "a; rm -rf /", { targetId: 1 })).toThrow(/名称只允许/);
});
