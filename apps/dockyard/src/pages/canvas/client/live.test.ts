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
  expect(s.targets[1]).toEqual({ status: "building", running: false, stage: "building" });
  // 粗 status 事件不带 stage → 保留
  s = applyLiveEvent(s, { type: "status", targetId: 1, status: "deploying" });
  expect(s.targets[1]).toEqual({ status: "deploying", running: false, stage: "building" });
  // 携带即推进
  s = applyLiveEvent(s, { type: "status", targetId: 1, status: "deploying", stage: "exposing" });
  expect(s.targets[1]!.stage).toBe("exposing");
});

test("running 事件：开播清旧 stage（断点不污染新一轮步骤条）", () => {
  let s: LiveState = emptyLive;
  s = applyLiveEvent(s, { type: "status", targetId: 1, status: "failed", stage: "building" });
  s = applyLiveEvent(s, { type: "running", targetId: 1, running: true });
  expect(s.targets[1]).toEqual({ status: "failed", running: true, stage: null });
  // 停播不动 stage（终态驻留段正是步骤条断点数据源）
  s = applyLiveEvent(s, { type: "status", targetId: 1, status: "failed", stage: "deploying" });
  s = applyLiveEvent(s, { type: "running", targetId: 1, running: false });
  expect(s.targets[1]!.stage).toBe("deploying");
});
