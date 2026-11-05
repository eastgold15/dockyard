/** @jsxImportSource solid-js */
/**
 * 只读日志视图（LogView）：xterm.js 渲染 ANSI 日志流，替代 <pre> 纯文本展示。
 * 复用现有 @xterm/xterm + @xterm/addon-fit（console.tsx 同款），不新增运行时依赖。
 *
 * 数据流约定：props.text 是「完整日志字符串」（不是增量）。组件内部自己算增量：
 * - 后续文本以旧文本为前缀 → 只 term.write 增量，避免每轮全量重写；
 * - 切换 run / 终态对齐 / 截断导致非前缀 → 清屏序列与正文放同一次 write 完整替换，
 *   保证顺序，避开异步 reset/write 竞态。
 *
 * 跟随策略：用户停在底部时自动跟随；向上翻阅后不强制拉回；全文替换后回到底部。
 */
import { createEffect, onCleanup, onMount } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// Harbor 色板的 ANSI 24 位前景色（与 system.md 原语对齐）：
// Signal 500 #d95d4e（错误）、Brass 500 #d9a441（警告）、Tide 400 #5ec4b6（成功）
const ANSI_SIGNAL = "38;2;217;93;78";
const ANSI_BRASS = "38;2;217;164;65";
const ANSI_TIDE = "38;2;94;196;182";

// 行级关键词分类（刻意很小：不写 parser，只给纯文本行套整行颜色）。
// 命中顺序错误 > 警告 > 成功；已有 ANSI 的行原样保留，不二次套色。
const RE_ERROR = /\b(?:error|fatal|failed to solve|failed|failure|exception|cannot|denied)\b|失败/i;
const RE_WARN = /\b(?:warn(?:ing)?|level=warning|canceled|cancelled)\b|警告/i;
const RE_DONE = /\b(?:done|success(?:ful|fully)?|succeed(?:ed|s)?|complet(?:e|ed|ion)?)\b|成功|完成/i;

const hasAnsi = (line: string) => line.includes("\x1b[");

/** 单行着色：纯文本按关键词分类；已有 ANSI 或空行原样返回 */
function colorizeLine(line: string): string {
  if (!line || hasAnsi(line)) return line;
  let code: string | null = null;
  if (RE_ERROR.test(line)) code = ANSI_SIGNAL;
  else if (RE_WARN.test(line)) code = ANSI_BRASS;
  else if (RE_DONE.test(line)) code = ANSI_TIDE;
  return code ? `\x1b[${code}m${line}\x1b[0m` : line;
}

/** 整段日志按行着色（split/join 保留换行结构与行尾空串） */
function colorizeLog(text: string): string {
  return text.split("\n").map(colorizeLine).join("\n");
}

/**
 * @param text 完整日志字符串（每次替换为当前权威全文）
 * @param height 容器 CSS 高度（如 "24rem" / "40vh"），xterm 依赖固定高度做 fit
 */
export function LogView(props: { text: string; height: string }) {
  let el!: HTMLDivElement;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let ro: ResizeObserver | undefined;
  let disposed = false;

  /** 上次已按 props.text 写入终端的完整文本（增量判断的锚点，纯文本不含 ANSI） */
  let written = "";

  /** 是否停在底部（baseY == viewportY 即视口在缓冲最末） */
  const isAtBottom = () => {
    const b = term!.buffer.active;
    return b.baseY - b.viewportY === 0;
  };

  /** 全量替换：清屏（含滚动区）序列与正文同一笔 write，保证顺序、避开异步 reset/write 竞态；
   *  用 write 回调在数据解析完成后回到底部（大日志异步解析时也能落到最末） */
  const replaceAll = (text: string) => {
    term!.write(`\x1b[2J\x1b[3J\x1b[H${colorizeLog(text)}`, () => {
      if (!disposed) term!.scrollToBottom();
    });
    written = text;
  };

  /** 增量：旧文本是前缀，只写增量部分；用户在底部则自动跟随，翻阅后不拉回 */
  const append = (delta: string) => {
    const wasAtBottom = isAtBottom();
    term!.write(colorizeLog(delta), () => {
      if (!disposed && wasAtBottom) term!.scrollToBottom();
    });
  };

  onMount(() => {
    term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: {
        background: "#0b0f14", // Harbor 950
        foreground: "#d4d4d8", // neutral-300
        cursor: "#0b0f14", // 只读视图隐藏光标
        selectionBackground: "#243040", // Harbor 700
        scrollbarSliderBackground: "#1a222c", // Harbor 800
        scrollbarSliderHoverBackground: "#243040", // Harbor 700
        scrollbarSliderActiveBackground: "#33445a", // Harbor 600
      },
      disableStdin: true,
      convertEol: true,
      scrollback: 5000, // 与 live.logs 的行数上限 LOG_TAIL_LIMIT 对齐
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const safeFit = () => {
      try {
        fit!.fit();
      } catch {
        /* 容器暂不可见（0 尺寸），等 ResizeObserver 再来一次 */
      }
    };
    safeFit();

    ro = new ResizeObserver(() => {
      if (!disposed) safeFit();
    });
    ro.observe(el);

    // 首帧：全量写入
    replaceAll(props.text);

    onCleanup(() => {
      disposed = true;
      ro!.disconnect();
      term!.dispose();
    });
  });

  createEffect(() => {
    // 必须先读 props.text：effect 首次执行建立对它的响应式依赖，
    // 若在守卫里提前 return 就不追踪，文本后续变化永远不会触发重跑
    const text = props.text;
    if (!term || disposed) return;
    if (text === written) return;
    if (text.startsWith(written)) {
      append(text.slice(written.length));
      written = text;
    } else {
      replaceAll(text);
    }
  });

  return (
    <div class="overflow-hidden rounded bg-harbor-950 p-2" style={{ height: props.height }}>
      <div ref={el} class="h-full w-full" />
    </div>
  );
}
