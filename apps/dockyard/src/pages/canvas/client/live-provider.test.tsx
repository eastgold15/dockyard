/** @jsxImportSource solid-js */
// LiveProvider 的契约：唯一 SSE 连接、按 target 键写入、discovery 帧转 refresh 事件。
// 作用域错位（只罩 Board 不罩抽屉）曾是 P0——抽屉拿到 emptyLive 永远不刷新。
import { expect, test } from "bun:test";
import { render } from "solid-js/web";
import { LiveProvider } from "./live-provider";
import { useDeployLog, useTargetLive } from "./live";

/** 假 EventSource：手动推帧，记录实例数（断言「只有一条连接」） */
class FakeES {
  static instances: FakeES[] = [];
  static push(msg: Record<string, unknown>) {
    for (const es of FakeES.instances) es.onmessage?.(new MessageEvent("message", { data: JSON.stringify(msg) }));
  }
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeES.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

const realES = globalThis.EventSource;
globalThis.EventSource = FakeES as unknown as typeof EventSource;

function mount() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  let live!: ReturnType<typeof useTargetLive>;
  let log!: ReturnType<typeof useDeployLog>;
  const dispose = render(
    () => (
      <LiveProvider>
        <div>
          {(() => {
            live = useTargetLive(1);
            log = useDeployLog(1);
            return null;
          })()}
          <span class="status">{live()?.status ?? "-"}</span>
        </div>
      </LiveProvider>
    ),
    el,
  );
  return {
    el,
    live: () => live(),
    log: () => log(),
    dispose: () => {
      dispose();
      el.remove();
      FakeES.instances = [];
      if (realES) globalThis.EventSource = realES;
    },
  };
}

test("只有一条 SSE 连接，状态按 target 键写入", () => {
  const h = mount();
  expect(FakeES.instances.length).toBe(1);
  expect(FakeES.instances[0]!.url).toBe("/api/canvas/events");

  FakeES.push({ type: "status", targetId: 1, runId: 7, status: "building", stage: "building" });
  expect(h.live()).toMatchObject({ status: "building", stage: "building", runId: 7 });
  expect(h.el.textContent).toContain("building");

  // 别的 target 的帧不污染 1
  FakeES.push({ type: "status", targetId: 2, runId: 8, status: "failed" });
  expect(h.live()!.status).toBe("building");
  h.dispose();
});

test("终态 status 帧顺带清 running（服务端快照只发 status 的语义）", () => {
  const h = mount();
  FakeES.push({ type: "running", targetId: 1, runId: 7, running: true });
  expect(h.live()).toMatchObject({ running: true, runId: 7 });
  FakeES.push({ type: "status", targetId: 1, runId: 7, status: "success" });
  expect(h.live()).toMatchObject({ status: "success", running: false });
  h.dispose();
});

test("日志帧按 run 增量合并，换 run 重置", () => {
  const h = mount();
  FakeES.push({ type: "log", targetId: 1, runId: 7, lines: ["a"] });
  FakeES.push({ type: "log", targetId: 1, runId: 7, lines: ["b"] });
  expect(h.log()).toEqual({ runId: 7, lines: ["a", "b"] });
  FakeES.push({ type: "log", targetId: 1, runId: 8, lines: ["c"] });
  expect(h.log()).toEqual({ runId: 8, lines: ["c"] });
  h.dispose();
});

test("discovery 帧转成 body 的 refresh 事件（结构变更走重拉）", () => {
  const h = mount();
  let fired = 0;
  const onRefresh = () => fired++;
  document.body.addEventListener("refresh", onRefresh);
  FakeES.push({ type: "discovery" });
  expect(fired).toBe(1);
  document.body.removeEventListener("refresh", onRefresh);
  h.dispose();
});

test("坏帧不抛（JSON 解析失败/未知类型都静默跳过）", () => {
  const h = mount();
  expect(() => {
    FakeES.instances[0]!.onmessage?.(new MessageEvent("message", { data: "{" }));
    FakeES.push({ type: "unknown" });
  }).not.toThrow();
  h.dispose();
});
