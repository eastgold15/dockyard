/** @jsxImportSource @solidjs/web */
/**
 * 只读日志视图（LogView）：用原生 DOM + ansi-to-html 渲染 ANSI 日志。
 * 不再用 xterm 画布——拖动选区、右键复制、Ctrl+C 全部走浏览器原生行为，
 * 不受字体度量 / fit / 画布坐标影响。交互式终端（ConsoleView）仍用 xterm。
 *
 * 数据流约定：props.text 是「完整日志字符串」（不是增量）。
 * - 新文本以已渲染文本为前缀 → 只往 DOM 追加增量；
 * - 切换 run / 终态对齐 / 截断导致非前缀 → 整段替换。
 *
 * 跟随策略：用户停在底部时自动跟随；向上翻阅后不强制拉回。
 */
import {
  createEffect,
  createSignal,
} from "solid-js";
import AnsiToHtml from "ansi-to-html";
import copy from "copy-to-clipboard";
import { button } from "../../../../../styled-system/recipes";

// Harbor 色板的 ANSI 24 位前景色（与 system.md 原语对齐）：
// Signal 500 #d95d4e（错误）、Brass 500 #d9a441（警告）、Tide 400 #5ec4b6（成功）
const ANSI_SIGNAL = "38;2;217;93;78";
const ANSI_BRASS = "38;2;217;164;65";
const ANSI_TIDE = "38;2;94;196;182";

// 行级关键词分类（刻意很小：不写 parser，只给纯文本行套整行颜色）。
// 命中顺序错误 > 警告 > 成功；已有 ANSI 的行原样保留，不二次套色。
const RE_ERROR =
  /\b(?:error|fatal|failed to solve|failed|failure|exception|cannot|denied)\b|失败/i;
const RE_WARN = /\b(?:warn(?:ing)?|level=warning|canceled|cancelled)\b|警告/i;
const RE_DONE =
  /\b(?:done|success(?:ful|fully)?|succeed(?:ed|s)?|complet(?:e|ed|ion)?)\b|成功|完成/i;

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

/** stream: true 让 ANSI 颜色状态跨多次 toHtml 连续，增量追加不会丢色 */
const CONVERT_OPTIONS = {
  fg: "#d4d4d8", // neutral-300
  bg: "#0b0f14", // Harbor 950
  newline: false, // <pre> 自己保留换行，不转 <br/>
  escapeXML: true, // 日志文本不可信，转义 HTML
  stream: true,
};

/**
 * @param text 完整日志字符串（每次替换为当前权威全文）
 * @param height 固定容器高度（如 "24rem"）；与 fill 二选一
 * @param fill 撑满父容器剩余空间（父级需是带确定高度的 flex 布局），抽屉内嵌日志用
 */
export function LogView(props: {
  text: string;
  height?: string;
  fill?: boolean;
}) {
  /** 外层滚动容器（复制行在它外面） */
  let box!: HTMLDivElement;
  /** 真正承载日志 HTML 的 <pre> */
  let pre!: HTMLPreElement;

  const [copied, setCopied] = createSignal(false);

  /** 已渲染的纯文本（增量判断的锚点） */
  let rendered = "";
  let converter = new AnsiToHtml(CONVERT_OPTIONS);

  const atBottom = () =>
    box.scrollTop + box.clientHeight >= box.scrollHeight - 8;

  /** 复制全部日志：直接复制 props.text（完整纯文本，不含 ANSI 颜色码）。
   *  copy-to-clipboard 自带 execCommand 降级，webview / 非安全上下文也能用。 */
  const copyAll = async () => {
    if (!(await copy(props.text))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  createEffect(
    // 跟踪阶段：只读取响应式，收集依赖，不要碰 DOM
    () => props.text,
    // 副作用阶段：untracked，在这里操作 DOM、scroll、ref
    (text) => {
      const wasAtBottom = atBottom();
      const prevTop = box.scrollTop;

      if (text.startsWith(rendered)) {
        const delta = text.slice(rendered.length);
        if (delta)
          pre.insertAdjacentHTML(
            "beforeend",
            converter.toHtml(colorizeLog(delta)),
          );
      } else {
        // 全量替换：换新 converter，防止 ANSI 状态串色
        converter = new AnsiToHtml(CONVERT_OPTIONS);
        pre.innerHTML = converter.toHtml(colorizeLog(text));
      }
      rendered = text;

      // 追加时保持滚动位置；底部跟随逻辑
      box.scrollTop = wasAtBottom ? box.scrollHeight : prevTop;
    }
  );

  return (
    <div
      class={
        props.fill
          ? "flex min-h-0 flex-1 flex-col gap-1.5"
          : "flex flex-col gap-1.5"
      }
    >
      <div class="flex items-center justify-end">
        <button
          type="button"
          class={button({ variant: "ghost", size: "sm" })}
          onClick={() => void copyAll()}
        >
          {copied() ? "已复制" : "复制全部日志"}
        </button>
      </div>
      <div
        ref={box}
        class={
          props.fill
            ? "min-h-40 flex-1 overflow-x-hidden overflow-y-auto rounded bg-harbor-950 px-2 pt-2 pb-3"
            : "overflow-x-hidden overflow-y-auto rounded bg-harbor-950 px-2 pt-2 pb-3"
        }
        style={props.fill ? undefined : { height: props.height }}
      >
        <pre
          ref={pre}
          class="m-0 whitespace-pre-wrap break-all text-xs leading-[1.4] text-neutral-300 selection:bg-brass-500/30"
        />
      </div>
    </div>
  );
}
