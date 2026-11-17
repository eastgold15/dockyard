// 三条日志通道的统一抽象（构建 / 运行时 / 控制台）：
//
// - LogSource：日志来源
// - LogChunk：一段日志（文本 + 毫秒时间戳）
// - RemoteStream：远端日志流；open(offset?) 增量消费，close() 停流
//
// 通道差异只在「怎么从远端拿到字节」：
// - BuildStream：远端后台跑 + 轮询 tail -c 窗口（offset = 已消费的远端字节偏移，可续传）
// - RuntimeStream：docker logs --follow（多路复用帧头需剥离）
// - ConsoleStream：docker exec hijack 的输出侧（TTY 原始字节，无帧头）
//
// 本文件不 import 任何 Node-only 包：client 侧经 deploy.socket 只取类型，
// 浏览器打包不受影响（纯类型导出在编译期被擦除）。
import { ServiceError } from "@elysiax/core";

/** 日志来源：build=部署构建，runtime=容器运行时，console=交互控制台 */
export type LogSource = "build" | "runtime" | "console";

/** 一段日志（文本 + 毫秒时间戳） */
export interface LogChunk {
  readonly text: string;
  readonly ts: number;
}

/**
 * 远端日志流：open(offset?) 返回可增量消费的异步迭代器。
 *
 * offset 的语义按来源而定：
 * - build：已消费的远端日志文件字节偏移（续传从此处继续 tail）
 * - runtime：since 时间戳（秒）；无则从当前时刻开始跟
 * - console：不支持续传（忽略）
 */
export interface RemoteStream {
  readonly source: LogSource;
  open(offset?: number): AsyncIterable<LogChunk>;
  close(): void;
}

/** 远端短命令执行结果（与 SSH exec 语义一致） */
export interface RemoteExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * 远端执行端口（SSH 中继 / 本机进程都实现它）。
 * exec 失败抛错；dropConnection 丢弃连接缓存（下轮重建）。
 */
export interface RemoteShell {
  /** 执行远端命令；retries 缺省用端口自身的默认重试次数 */
  exec(cmd: string, retries?: number): Promise<RemoteExecResult>;
  /** 连接失效：丢弃缓存的连接（下轮重建） */
  dropConnection(): void;
}

/** BuildStream 的依赖 */
export interface BuildStreamOptions {
  shell: RemoteShell;
  /** 远端日志文件 tag（路径形如 /tmp/dockyard-long-<tag>.log） */
  tag: string;
  /** 单轮窗口字节数（构建日志可达数 MB，弱网下全量重传必然反复失败） */
  windowBytes?: number;
  /** 轮询间隔（毫秒） */
  intervalMs?: number;
  /** 窗口读满时的加速间隔（毫秒） */
  fastIntervalMs?: number;
}

const DEFAULT_WINDOW_BYTES = 262_144;
const DEFAULT_INTERVAL_MS = 4_000;
const DEFAULT_FAST_INTERVAL_MS = 300;

/**
 * 构建日志流：远端后台跑一条命令（nohup），再轮询日志文件的字节窗口。
 *
 * 单条 exec 挂几十分钟会被中间网络/sshd 断开，通道一关命令就被 SIGHUP 杀掉；
 * nohup 后台 + 短轮询则断线只废掉一次轮询，重连后续跑，构建本体不受影响。
 */
export class BuildStream implements RemoteStream {
  readonly source: LogSource = "build";
  /** 远端命令退出码（open() 消费结束后可读；命令未结束为 null） */
  exitCode: number | null = null;
  private closed = false;

  constructor(private readonly opts: BuildStreamOptions) {}

  /** 远端日志文件路径（tag → /tmp/dockyard-long-<tag>.log） */
  get logFile(): string {
    return `/tmp/dockyard-long-${this.opts.tag}.log`;
  }

  /** 远端退出码文件路径 */
  get codeFile(): string {
    return `${this.logFile}.code`;
  }

  /**
   * 远端后台启动命令（防 SIGHUP）。
   * < /dev/null 必须：后台进程继承通道 stdin 会让 sshd 一直等 EOF，
   * start 命令挂到构建结束才返回。
   */
  async start(cmd: string): Promise<void> {
    const logFile = this.logFile;
    const codeFile = this.codeFile;
    const partFile = `${logFile}.part`;
    const quoted = cmd.replace(/'/g, `'\\''`);
    const started = await this.opts.shell.exec(
      `rm -f ${logFile} ${codeFile} ${partFile} && nohup sh -c '${quoted}; echo $? > ${codeFile}' > ${logFile} 2>&1 < /dev/null & echo started`,
    );
    if (started.code !== 0)
      throw new ServiceError(`远端后台命令启动失败：${started.stderr}`);
  }

  /**
   * 轮询消费远端日志窗口；命令结束且日志排空后迭代终止。
   * offset = 已消费的远端字节偏移（续传时跳过已读部分）。
   */
  async *open(offset = 0): AsyncIterable<LogChunk> {
    const windowBytes = this.opts.windowBytes ?? DEFAULT_WINDOW_BYTES;
    const intervalMs = this.opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    const fastIntervalMs = this.opts.fastIntervalMs ?? DEFAULT_FAST_INTERVAL_MS;
    const logFile = this.logFile;
    const codeFile = this.codeFile;
    const partFile = `${logFile}.part`;
    let pos = offset;
    let delay = intervalMs;
    for (;;) {
      if (this.closed) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = intervalMs;
      let res: RemoteExecResult;
      try {
        res = await this.opts.shell.exec(
          // 窗口读取：每轮最多 windowBytes
          // 服务端报告本次实际输出字节数，避免客户端按解码后字符串估算偏移踩 UTF-8 边界
          `tail -c +${pos + 1} ${logFile} 2>/dev/null | head -c ${windowBytes} > ${partFile}; cat ${partFile};` +
            `printf '\\n__DC_SIZE__\\n'; wc -c < ${partFile}; printf '__DC_CODE__\\n'; cat ${codeFile} 2>/dev/null || true`,
          0,
        );
      } catch {
        // 断线：本轮轮询作废，丢连接缓存后下轮续跑
        this.opts.shell.dropConnection();
        continue;
      }
      const [rest = "", codeText = ""] = res.stdout.split("__DC_CODE__\n");
      const [chunk = "", sizeText = "0"] = rest.split("\n__DC_SIZE__\n");
      const printed = Number(sizeText.trim());
      if (Number.isFinite(printed) && printed > 0) {
        pos += printed;
        const text = chunk.trimEnd();
        if (text) yield { text, ts: Date.now() };
        if (printed >= windowBytes) delay = fastIntervalMs; // 读满窗口说明积压严重，加速排空
      }
      const codeStr = codeText.trim();
      // 命令已结束但日志还有积压时继续排空（失败上下文在文件尾部），printed==0 说明已追到 EOF
      if (codeStr !== "" && (!Number.isFinite(printed) || printed === 0)) {
        const code = Number(codeStr);
        this.exitCode = Number.isFinite(code) ? code : -1;
        return;
      }
    }
  }

  close(): void {
    this.closed = true;
  }
}

/**
 * docker 多路复用帧头（8 字节）：[stream_type(1), 0, 0, 0, size(4, 大端)]。
 * 非 TTY 容器的 logs/attach 输出带帧头，必须剥离才是纯文本。
 */
const FRAME_HEADER_BYTES = 8;

/** 判断一段字节是否为多路复用帧头（TTY 容器没有帧头，按纯文本处理） */
function looksLikeFrameHeader(buf: Uint8Array): boolean {
  return (
    buf.length >= FRAME_HEADER_BYTES &&
    buf[0]! <= 2 &&
    buf[1] === 0 &&
    buf[2] === 0 &&
    buf[3] === 0
  );
}

/**
 * 流式解帧器：把 docker 的多路复用字节流还原成文本。
 *
 * 帧可能跨 chunk 边界（半帧），必须缓冲到齐再吐——一次性解码只在整块缓冲时成立。
 * TTY 容器（exec 控制台）没有帧头：首字节不像帧头时按纯文本直通。
 */
export class DockerFrameDecoder {
  private buf: Uint8Array = new Uint8Array(0);
  private framed: boolean | null = null;
  private readonly decoder = new TextDecoder("utf-8");

  /** 喂入一段原始字节，返回可读文本 */
  push(chunk: Uint8Array): string {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    if (this.framed === null) {
      if (this.buf.length < FRAME_HEADER_BYTES) return "";
      this.framed = looksLikeFrameHeader(this.buf);
    }
    if (!this.framed) {
      // 纯文本流（TTY）：直接吐出去（后续不再缓冲）
      const text = this.decoder.decode(this.buf, { stream: true });
      this.buf = new Uint8Array(0);
      return text;
    }

    let out = "";
    for (;;) {
      if (this.buf.length < FRAME_HEADER_BYTES) break;
      const size =
        (this.buf[4]! << 24) |
        (this.buf[5]! << 16) |
        (this.buf[6]! << 8) |
        this.buf[7]!;
      if (this.buf.length < FRAME_HEADER_BYTES + size) break; // 半帧：等下一批
      out += this.decoder.decode(
        this.buf.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + size),
        { stream: true },
      );
      this.buf = this.buf.subarray(FRAME_HEADER_BYTES + size);
    }
    return out;
  }

  /** 流结束：吐出残留字节（纯文本流的半个 UTF-8 字符在这里补齐） */
  flush(): string {
    const text = this.decoder.decode(this.buf, { stream: false });
    this.buf = new Uint8Array(0);
    return text;
  }
}

/** 一次性解帧（整块缓冲已知完整时用；runtime.service 的历史日志快照走这里） */
export function decodeDockerFrames(buf: Uint8Array): string {
  const decoder = new DockerFrameDecoder();
  return decoder.push(buf) + decoder.flush();
}

/** 容器日志端口（dockerode container.logs 的窄口：follow 模式返回可读字节流） */
export interface ContainerLogsPort {
  logs(options: {
    follow: true;
    stdout: true;
    stderr: true;
    since?: number;
  }): Promise<AsyncIterable<unknown>>;
}

/**
 * 运行时日志流：docker logs --follow（stdout+stderr 合流）。
 *
 * 非 TTY 容器的输出带 8 字节多路复用帧头，必须边读边剥（帧可跨 chunk 边界）。
 */
export class RuntimeStream implements RemoteStream {
  readonly source: LogSource = "runtime";
  private closed = false;

  constructor(private readonly container: ContainerLogsPort) {}

  async *open(offset = 0): AsyncIterable<LogChunk> {
    const since = offset > 0 ? offset : Math.floor(Date.now() / 1000);
    const stream = await this.container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      since,
    });
    const decoder = new DockerFrameDecoder();
    for await (const raw of stream) {
      if (this.closed) return;
      const bytes =
        typeof raw === "string"
          ? new TextEncoder().encode(raw)
          : raw instanceof Uint8Array
            ? raw
            : new Uint8Array(0);
      if (!bytes.length) continue;
      const text = decoder.push(bytes);
      if (text) yield { text, ts: Date.now() };
    }
    const tail = decoder.flush();
    if (tail) yield { text: tail, ts: Date.now() };
  }

  close(): void {
    this.closed = true;
  }
}

/** 控制台可读端口（docker exec hijack 的输出侧） */
export interface ConsoleReadablePort {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

/**
 * 控制台日志流：docker exec hijack 的输出侧。
 *
 * 双向流：输入侧（写入命令）仍走 WS 路径，这里只消费输出侧。
 * TTY 会话没有多路复用帧头，字节直接按文本解。
 */
export class ConsoleStream implements RemoteStream {
  readonly source: LogSource = "console";
  private closed = false;

  constructor(private readonly readable: ConsoleReadablePort) {}

  async *open(): AsyncIterable<LogChunk> {
    const decoder = new TextDecoder("utf-8");
    for await (const raw of this.readable) {
      if (this.closed) return;
      const text =
        typeof raw === "string"
          ? raw
          : raw instanceof Uint8Array
            ? decoder.decode(raw, { stream: true })
            : "";
      if (text) yield { text, ts: Date.now() };
    }
  }

  close(): void {
    this.closed = true;
  }
}
