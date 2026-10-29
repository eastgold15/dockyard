/**
 * 更新轮询回归点：
 * - 判定是纯函数：基线缺失不亮徽章、sha 变化才亮、auto 同 sha 只触发一次
 * - 本地来源读本地 git HEAD（非 git 目录静默跳过，不能让轮询崩）
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitHeadSha, updateDecision } from "./update-poller";

test("updateDecision：无基线不亮徽章，sha 变化才亮", () => {
  expect(updateDecision({ lastKnownSha: null, headSha: "abc12345", deployPolicy: "notify" }).available).toBe(false);
  expect(updateDecision({ lastKnownSha: "abc12345", headSha: "abc12345", deployPolicy: "notify" }).available).toBe(false);
  expect(updateDecision({ lastKnownSha: "abc12345", headSha: "def67890", deployPolicy: "notify" }).available).toBe(true);
});

test("updateDecision：auto 只在有新 sha 且未触发过时触发", () => {
  expect(updateDecision({ lastKnownSha: "abc12345", headSha: "def67890", deployPolicy: "auto" }).autoTrigger).toBe(true);
  // 同 sha 已 auto 触发过（失败不重试）
  expect(
    updateDecision({ lastKnownSha: "abc12345", headSha: "def67890", deployPolicy: "auto", lastAutoSha: "def67890" })
      .autoTrigger,
  ).toBe(false);
  // notify/manual 永不自动部署
  expect(updateDecision({ lastKnownSha: "abc12345", headSha: "def67890", deployPolicy: "notify" }).autoTrigger).toBe(false);
  expect(updateDecision({ lastKnownSha: "abc12345", headSha: "def67890", deployPolicy: "manual" }).autoTrigger).toBe(false);
  // 无变化不触发
  expect(updateDecision({ lastKnownSha: "abc12345", headSha: "abc12345", deployPolicy: "auto" }).autoTrigger).toBe(false);
});

test("gitHeadSha：git 目录返回 8 位短 sha，非 git 目录返回 null", async () => {
  const sha = await gitHeadSha(join(import.meta.dir, "../../../.."));
  expect(sha).toMatch(/^[0-9a-f]{8}$/);
  const empty = await mkdtemp(join(tmpdir(), "dockyard-nogit-"));
  try {
    expect(await gitHeadSha(empty)).toBeNull();
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
