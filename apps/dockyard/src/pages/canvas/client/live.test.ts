// nextTargetLive / nextLog 是 LiveProvider 按键写 store 时实际调用的纯函数（无 DOM），
// 直接跑 bun test。合并语义只在这两个函数里有一份实现——测试它们才是测生产路径。
import { expect, test } from "bun:test";
import { LOG_TAIL_LIMIT, nextLog, nextTargetLive, type TargetLive } from "./live";

/** 喂一帧给 nextTargetLive（status/running 帧必有下一状态，测试里直接断言） */
const step = (prev: TargetLive | undefined, msg: Record<string, unknown>): TargetLive =>
  nextTargetLive(prev, msg) as TargetLive;

test("log 帧：同 run 追加、换 run 重置", () => {
  let cur = nextLog(undefined, { type: "log", runId: 10, lines: ["a", "b"] })!;
  cur = nextLog(cur, { type: "log", runId: 10, lines: ["c"] })!;
  expect(cur).toEqual({ runId: 10, lines: ["a", "b", "c"] });
  // 新 run 开播，旧行全部丢弃
  cur = nextLog(cur, { type: "log", runId: 11, lines: ["x"] })!;
  expect(cur).toEqual({ runId: 11, lines: ["x"] });
});

test("log 坏帧：runId 缺失时沿用当前块所属 run，连当前块都没有则丢弃", () => {
  // 首帧就没 runId：无从归属 → null（不写一个 runId=undefined 的假块）
  expect(nextLog(undefined, { type: "log", lines: ["a"] })).toBeNull();
  // 已有 run 10 的块：坏帧的行仍归 10，不丢日志
  const cur = nextLog(undefined, { type: "log", runId: 10, lines: ["a"] })!;
  expect(nextLog(cur, { type: "log", lines: ["b"] })).toEqual({ runId: 10, lines: ["a", "b"] });
  // lines 不是数组（字符串/数字/对象）：不逐字符展开、不抛错，按空帧保留已有行
  expect(nextLog(cur, { type: "log", runId: 10, lines: "x\ny" })).toEqual({ runId: 10, lines: ["a"] });
  expect(nextLog(cur, { type: "log", runId: 10, lines: 42 })).toEqual({ runId: 10, lines: ["a"] });
  expect(nextLog(cur, { type: "log", runId: 10, lines: { a: 1 } })).toEqual({ runId: 10, lines: ["a"] });
  // 数组里混入非字符串：只保留字符串元素
  expect(nextLog(cur, { type: "log", runId: 10, lines: ["b", 7, null] })).toEqual({ runId: 10, lines: ["a", "b"] });
});

test("log 帧：行数超上限丢弃最旧行", () => {
  const cur = nextLog(undefined, {
    type: "log",
    runId: 10,
    lines: Array.from({ length: LOG_TAIL_LIMIT + 100 }, (_, i) => `L${i}`),
  })!;
  expect(cur.lines.length).toBe(LOG_TAIL_LIMIT);
  expect(cur.lines[0]).toBe("L100"); // 最旧 100 行被裁
  expect(cur.lines.at(-1)).toBe(`L${LOG_TAIL_LIMIT + 99}`);
});

test("status 帧：stage 携带才更新，缺省保留旧值", () => {
  let t = step(undefined, { type: "status", status: "building", stage: "building" });
  expect(t).toEqual({ status: "building", running: false, stage: "building", runId: null });
  // 粗 status 事件不带 stage → 保留
  t = step(t, { type: "status", status: "deploying" });
  expect(t).toEqual({ status: "deploying", running: false, stage: "building", runId: null });
  // 携带即推进
  t = step(t, { type: "status", status: "deploying", stage: "exposing" });
  expect(t.stage).toBe("exposing");
});

test("running 帧：开播清旧 stage（断点不污染新一轮步骤条）", () => {
  let t = step(undefined, { type: "status", status: "failed", stage: "building" });
  t = step(t, { type: "running", running: true });
  expect(t).toEqual({ status: "failed", running: true, stage: null, runId: null });
  // 停播不动 stage（终态驻留段正是步骤条断点数据源）
  t = step(t, { type: "status", status: "failed", stage: "deploying" });
  t = step(t, { type: "running", running: false });
  expect(t.stage).toBe("deploying");
});

test("终态 status 必然停播 running：快照只发 status 不发 running:false 也不卡「部署中」", () => {
  let t = step(undefined, { type: "running", runId: 7, running: true });
  expect(t).toEqual({ status: null, running: true, stage: null, runId: 7 });
  // 断线重连首帧快照：只回来一条 success
  t = step(t, { type: "status", runId: 7, status: "success" });
  expect(t).toMatchObject({ status: "success", running: false });
  // failed 同语义
  t = step(t, { type: "status", runId: 8, status: "failed" });
  expect(t).toMatchObject({ status: "failed", running: false });
});

test("status 坏帧：缺字段/未知值整帧丢弃，不写进 store（否则按钮永久「部署中…」）", () => {
  const prev: TargetLive = { status: "building", running: true, stage: "building", runId: 7 };
  expect(nextTargetLive(prev, { type: "status", runId: 7 })).toBeNull();
  expect(nextTargetLive(prev, { type: "status", runId: 7, status: 42 })).toBeNull();
  expect(nextTargetLive(prev, { type: "status", runId: 7, status: "half-done" })).toBeNull();
  // 合法值照常合并（丢弃坏帧不能把好帧一起挡掉）
  expect(nextTargetLive(prev, { type: "status", runId: 7, status: "success" })).toMatchObject({
    status: "success",
    running: false,
  });
});

test("runId 携带即换主，缺省保留：日志抽屉按 runId 判断实时状态归属", () => {
  let t = step(undefined, { type: "status", runId: 7, status: "building" });
  expect(t.runId).toBe(7);
  // 粗事件不带 runId → 沿用上一次（同一 run 的后续迁移）
  t = step(t, { type: "status", status: "deploying" });
  expect(t.runId).toBe(7);
  // 新 run 开播带上新 runId → 换主
  t = step(t, { type: "running", runId: 8, running: true });
  expect(t.runId).toBe(8);
});
