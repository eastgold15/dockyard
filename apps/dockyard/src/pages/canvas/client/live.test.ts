// applyLiveEvent 是纯函数（无 DOM），直接跑 bun test。
import { expect, test } from "bun:test";
import { applyLiveEvent, emptyLive, LOG_TAIL_LIMIT, type LiveState } from "./live";

test("log 事件：同 run 追加、换 run 重置", () => {
  let s: LiveState = emptyLive;
  s = applyLiveEvent(s, { type: "log", targetId: 1, runId: 10, lines: ["a", "b"] });
  s = applyLiveEvent(s, { type: "log", targetId: 1, runId: 10, lines: ["c"] });
  expect(s.logs[1]).toEqual({ runId: 10, lines: ["a", "b", "c"] });
  // 新 run 开播，旧行全部丢弃
  s = applyLiveEvent(s, { type: "log", targetId: 1, runId: 11, lines: ["x"] });
  expect(s.logs[1]).toEqual({ runId: 11, lines: ["x"] });
  // 不同 target 互不干扰
  s = applyLiveEvent(s, { type: "log", targetId: 2, runId: 20, lines: ["y"] });
  expect(s.logs[1]?.runId).toBe(11);
  expect(s.logs[2]?.lines).toEqual(["y"]);
});

test("log 事件：行数超上限丢弃最旧行", () => {
  let s: LiveState = emptyLive;
  s = applyLiveEvent(s, {
    type: "log", targetId: 1, runId: 10,
    lines: Array.from({ length: LOG_TAIL_LIMIT + 100 }, (_, i) => `L${i}`),
  });
  const lines = s.logs[1]!.lines;
  expect(lines.length).toBe(LOG_TAIL_LIMIT);
  expect(lines[0]).toBe("L100"); // 最旧 100 行被裁
  expect(lines.at(-1)).toBe(`L${LOG_TAIL_LIMIT + 99}`);
});

test("status 事件：stage 携带才更新，缺省保留旧值", () => {
  let s: LiveState = emptyLive;
  s = applyLiveEvent(s, { type: "status", targetId: 1, status: "building", stage: "building" });
  expect(s.targets[1]).toEqual({ status: "building", running: false, stage: "building", runId: null });
  // 粗 status 事件不带 stage → 保留
  s = applyLiveEvent(s, { type: "status", targetId: 1, status: "deploying" });
  expect(s.targets[1]).toEqual({ status: "deploying", running: false, stage: "building", runId: null });
  // 携带即推进
  s = applyLiveEvent(s, { type: "status", targetId: 1, status: "deploying", stage: "exposing" });
  expect(s.targets[1]!.stage).toBe("exposing");
});

test("running 事件：开播清旧 stage（断点不污染新一轮步骤条）", () => {
  let s: LiveState = emptyLive;
  s = applyLiveEvent(s, { type: "status", targetId: 1, status: "failed", stage: "building" });
  s = applyLiveEvent(s, { type: "running", targetId: 1, running: true });
  expect(s.targets[1]).toEqual({ status: "failed", running: true, stage: null, runId: null });
  // 停播不动 stage（终态驻留段正是步骤条断点数据源）
  s = applyLiveEvent(s, { type: "status", targetId: 1, status: "failed", stage: "deploying" });
  s = applyLiveEvent(s, { type: "running", targetId: 1, running: false });
  expect(s.targets[1]!.stage).toBe("deploying");
});

test("终态 status 必然停播 running：快照只发 status 不发 running:false 也不卡「部署中」", () => {
  let s: LiveState = emptyLive;
  s = applyLiveEvent(s, { type: "running", targetId: 1, runId: 7, running: true });
  expect(s.targets[1]).toEqual({ status: null, running: true, stage: null, runId: 7 });
  // 断线重连首帧快照：只回来一条 success
  s = applyLiveEvent(s, { type: "status", targetId: 1, runId: 7, status: "success" });
  expect(s.targets[1]).toMatchObject({ status: "success", running: false });
  // failed 同语义
  s = applyLiveEvent(s, { type: "status", targetId: 1, runId: 8, status: "failed" });
  expect(s.targets[1]).toMatchObject({ status: "failed", running: false });
});

test("runId 携带即换主，缺省保留：日志抽屉按 runId 判断实时状态归属", () => {
  let s: LiveState = emptyLive;
  s = applyLiveEvent(s, { type: "status", targetId: 1, runId: 7, status: "building" });
  expect(s.targets[1]!.runId).toBe(7);
  // 粗事件不带 runId → 沿用上一次（同一 run 的后续迁移）
  s = applyLiveEvent(s, { type: "status", targetId: 1, status: "deploying" });
  expect(s.targets[1]!.runId).toBe(7);
  // 新 run 开播带上新 runId → 换主
  s = applyLiveEvent(s, { type: "running", targetId: 1, runId: 8, running: true });
  expect(s.targets[1]!.runId).toBe(8);
});
