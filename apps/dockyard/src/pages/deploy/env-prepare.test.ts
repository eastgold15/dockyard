import { describe, expect, test } from "bun:test";
import { auditSummary, resolveEnvBindings, sourceKeyOf } from "./env-prepare";
import type { EnvBinding, EnvSource } from "./env-prepare";

const src = (
  id: number,
  vars: { key: string; value: string; secret?: boolean }[],
): EnvSource => ({
  sourceKind: "db",
  sourceId: id,
  name: `db-${id}`,
  dbType: "postgres",
  logical: false,
  sameServer: true,
  envKey: "DATABASE_URL",
  vars: vars.map((v) => ({
    key: v.key,
    value: v.value,
    secret: v.secret ?? false,
    kind: "image" as const,
  })),
  bindable: true,
});

const bind = (patch: Partial<EnvBinding> = {}): EnvBinding => ({
  sourceKind: "db",
  sourceId: 12,
  keys: ["DATABASE_URL"],
  ...patch,
});

describe("sourceKeyOf", () => {
  test("同来源同键", () => {
    expect(sourceKeyOf({ sourceKind: "db", sourceId: 12 })).toBe("db:12");
    expect(sourceKeyOf({ sourceKind: "shared", sourceId: 3 })).toBe("shared:3");
  });
});

describe("resolveEnvBindings", () => {
  test("绑定值注入到手填变量里", () => {
    const r = resolveEnvBindings({
      manualText: "PORT=3000\n",
      bindings: [bind()],
      sources: new Map([
        ["db:12", src(12, [{ key: "DATABASE_URL", value: "postgres://h/db" }])],
      ]),
    });
    expect(r.envText).toContain("DATABASE_URL=postgres://h/db");
    expect(r.envText).toContain("PORT=3000");
    expect(r.missing).toEqual([]);
  });

  test("手填优先：同名时手填值保留", () => {
    const r = resolveEnvBindings({
      manualText: "DATABASE_URL=postgres://mine/db\n",
      bindings: [bind()],
      sources: new Map([
        ["db:12", src(12, [{ key: "DATABASE_URL", value: "postgres://theirs/db" }])],
      ]),
    });
    expect(r.envText).toContain("DATABASE_URL=postgres://mine/db");
    expect(r.audit.find((a) => a.status === "manual-wins")!.key).toBe(
      "DATABASE_URL",
    );
  });

  test("绑定之间冲突：先保存的赢", () => {
    const r = resolveEnvBindings({
      manualText: "",
      bindings: [bind(), bind({ sourceId: 13 })],
      sources: new Map([
        ["db:12", src(12, [{ key: "DATABASE_URL", value: "first" }])],
        ["db:13", src(13, [{ key: "DATABASE_URL", value: "second" }])],
      ]),
    });
    expect(r.envText).toContain("DATABASE_URL=first");
    expect(r.audit.some((a) => a.status === "conflict")).toBe(true);
  });

  test("rename 改目标键名", () => {
    const r = resolveEnvBindings({
      manualText: "",
      bindings: [bind({ rename: { DATABASE_URL: "MAIN_DB" } })],
      sources: new Map([
        ["db:12", src(12, [{ key: "DATABASE_URL", value: "pg://h/db" }])],
      ]),
    });
    expect(r.envText).toContain("MAIN_DB=pg://h/db");
    expect(r.envText).not.toContain("DATABASE_URL=");
  });

  test("来源里没有的键记 missing，不静默跳过", () => {
    const r = resolveEnvBindings({
      manualText: "",
      bindings: [bind({ keys: ["GONE"] })],
      sources: new Map([
        ["db:12", src(12, [{ key: "DATABASE_URL", value: "x" }])],
      ]),
    });
    expect(r.missing).toHaveLength(1);
    expect(r.missing[0]).toBe("db:12:GONE");
    expect(r.envText).not.toContain("GONE");
  });

  test("没有绑定时手填原样通过", () => {
    const r = resolveEnvBindings({
      manualText: "A=1\nB=2\n",
      bindings: [],
      sources: new Map(),
    });
    expect(r.envText).toContain("A=1");
    expect(r.envText).toContain("B=2");
  });
});

describe("auditSummary", () => {
  test("只输出键名，不输出值", () => {
    const r = resolveEnvBindings({
      manualText: "PORT=3000\n",
      bindings: [bind()],
      sources: new Map([
        ["db:12", src(12, [{ key: "DATABASE_URL", value: "postgres://secret/db" }])],
      ]),
    });
    const text = auditSummary(r.audit).join("\n");
    expect(text).toContain("DATABASE_URL");
    expect(text).not.toContain("postgres://secret/db");
  });
});
