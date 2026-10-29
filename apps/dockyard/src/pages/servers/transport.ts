/**
 * 服务器传输层：部署/边缘/资源链路只依赖这个窄接口。
 *
 * 两种实现：
 * - 远程 = SSH 客户端（SshClient 结构上满足本接口）；
 * - 本机 = 本地进程（LocalTransport），不经 SSH、不需要 sshd/密钥/端口——
 *   本机是程序自己认领的资源，通道就是「直接在本机执行」。
 */
import { homedir } from "node:os";
import { writeFile } from "node:fs/promises";
import { openSftp } from "@meitaim/ssh/sftp";
import type { SshClient } from "@meitaim/ssh";

/** 与 SSH ExecResult 同形（code/signal 等字段保留，调用方按 code 判成败） */
export interface ServerExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: string | null;
  readonly coreDumped: boolean | null;
  readonly errorMessage: string | null;
}

export interface ServerTransport {
  /** 判别式：本机通道走本地实现（sftp 助手据此分派） */
  readonly local: boolean;
  exec(cmd: string): Promise<ServerExecResult>;
  close(): Promise<void>;
}

/** 本机传输：直接起本地 bash 进程；每次 exec 与前一次无共享状态（与 SSH exec 语义一致） */
export class LocalTransport implements ServerTransport {
  readonly local = true;

  async exec(cmd: string): Promise<ServerExecResult> {
    const proc = Bun.spawn(["bash", "-lc", cmd], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      stdout,
      stderr,
      code,
      // bun-types 1.4.4 把 signalCode 标成 number | Signals | null
      signal: proc.signalCode == null ? null : String(proc.signalCode),
      coreDumped: null,
      errorMessage: null,
    };
  }

  /** 无长连接可关 */
  async close(): Promise<void> {}
}

/** 传输层上的文件写入（调用方只用到 write/close） */
export interface ServerSftp {
  write(path: string, contents: string | Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/**
 * 打开文件通道：远程走真 SFTP；本机直接落盘。
 * 调用方纪律不变——写秘密文件前先过 preflight 归属校验。
 */
export async function openServerSftp(transport: ServerTransport): Promise<ServerSftp> {
  if (!transport.local) return openSftp(transport as unknown as SshClient);
  return {
    async write(path, contents) {
      const abs = path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
      await writeFile(abs, contents);
    },
    async close() {},
  };
}
