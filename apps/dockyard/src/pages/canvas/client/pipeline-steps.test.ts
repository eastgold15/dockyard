// 步骤条纯函数（无 DOM），直接跑 bun test。
import { expect, test } from "bun:test";
import { stagePosture, stepStates } from "./pipeline-steps";

const githubApp = { kind: "app", repoUrl: "https://github.com/x/y", instanceOf: null } as const;
const localApp = { kind: "app", repoUrl: null, instanceOf: null } as const;
const dbContainer = { kind: "db", repoUrl: null, instanceOf: null } as const;

test("stage=null（旁路/存量）整体降级", () => {
  expect(stagePosture(githubApp, { trigger: "ui", stage: null })).toBeNull();
  expect(stagePosture(dbContainer, { trigger: "ui", stage: null })).toBeNull();
});

test("形态推导：github 免传输 / db 容器免构建 / local 全段", () => {
  const gh = stagePosture(githubApp, { trigger: "ui", stage: "building" })!;
  expect([...gh.skipped]).toEqual(["transferring"]);
  const db = stagePosture(dbContainer, { trigger: "ui", stage: "transferring" })!;
  expect([...db.skipped]).toEqual(["building"]);
  const local = stagePosture(localApp, { trigger: "ui", stage: "building" })!;
  expect(local.skipped.size).toBe(0);
});

test("回滚：前三段跳过 + 不产新产物", () => {
  const p = stagePosture(githubApp, { trigger: "rollback", stage: "deploying" })!;
  expect([...p.skipped]).toEqual(["sourcing", "building", "transferring", "packaging"]);
});

test("仅传输：后三段不适用", () => {
  const p = stagePosture(localApp, { trigger: "ship", stage: "transferring" })!;
  expect([...p.na]).toEqual(["deploying", "exposing", "packaging"]);
});

test("完成态推导：success 全绿（跳过段保持跳过）", () => {
  const p = stagePosture(githubApp, { trigger: "ui", stage: "packaging" })!;
  expect(stepStates("packaging", "success", p)).toEqual([
    "done", "done", "skipped", "done", "done", "done",
  ]);
});

test("失败断点：驻留段红叉，前段绿，后段灰", () => {
  const p = stagePosture(localApp, { trigger: "ui", stage: "transferring" })!;
  expect(stepStates("transferring", "failed", p)).toEqual([
    "done", "done", "failed", "pending", "pending", "pending",
  ]);
});

test("进行中：当前段脉冲", () => {
  const p = stagePosture(localApp, { trigger: "ui", stage: "building" })!;
  expect(stepStates("building", "building", p)).toEqual([
    "done", "active", "pending", "pending", "pending", "pending",
  ]);
});

test("ship 成功：前三段绿、后三段 na（不是 pending 假象）", () => {
  const p = stagePosture(localApp, { trigger: "ship", stage: "transferring" })!;
  expect(stepStates("transferring", "success", p)).toEqual([
    "done", "done", "done", "na", "na", "na",
  ]);
});
