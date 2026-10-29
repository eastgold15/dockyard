/**
 * 服务器传输层：部署/边缘/资源链路只依赖这个窄接口。
 *
 * 两种实现：
 * - 远程 = remoteTransport(SshClient)：收窄包装，SFTP 能力留在闭包里；
 * - 本机 = 本地进程（LocalTransport），不经 SSH、不需要 sshd/密钥/端口——
 *   本机是程序自己认领的资源，通道就是「直接在本机执行」。
 *
 * 生命周期归池/进程所有：transport 是「视图」，不提供 close——远程关掉共享的
 * SshPool 连接会让池里其他调用方拿到已断开的 client。要断连走 ServerService.dropSsh。
 */
import { homedir } from "node:os";
import { writeFile } from "@visulima/fs";
import { openSftp } from "@meitaim/ssh/sftp";
import type { ExecResult, SshClient } from "@meitaim/ssh";

/** 就是 SSH 的 ExecResult（同一份契约，别另抄一份结构字段漂移） */
export type ServerExecResult = ExecResult;

export interface ServerTransport {
  exec(cmd: string): Promise<ServerExecResult>;
  /** 文件写入通道：远程 = 真 SFTP 会话，本机 = 直接落盘。
   *  必须由实现方提供——远程通道是收窄后的包装对象，没有 SSH 的 session()；
   *  若在调用方把包装对象强转回 SshClient 去开 SFTP，远端必炸（TypeError: session is
   *  not a function），而本机单测永远发现不了 */
  sftp(): Promise<ServerSftp>;
}

/** 本机传输：直接起本地 bash 进程；每次 exec 与前一次无共享状态（与 SSH exec 语义一致） */
export class LocalTransport implements ServerTransport {
  async exec(cmd: string): Promise<ServerExecResult> {
    // 不用 `bash -lc`：登录 shell 会加载 ~/.bash_profile 等，profile 里任何 echo
    // （fastfetch、版本横幅、greeting）都会混进 stdout，把 `printf %s "$HOME"`、
    // `docker version --format`、base64 备份这类「输出即数据」的命令污染成垃圾。
    // 非交互 `-c` 不读 profile/rc，PATH 由 dockyard 进程环境继承。
    const proc = Bun.spawn(["bash", "-c", cmd], {
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

  /** 本机文件通道：直接落盘，不建 SFTP 会话（~ 展开成 home）。
   *  0600：这条通道会写 .env/证书等秘密文件，默认权限随 umask（常见 644）等于对同机
   *  其他用户公开；远端 SFTP 路径另有 chmod 600 收口，本机落盘必须同标准。 */
  async sftp(): Promise<ServerSftp> {
    return {
      async write(path, contents) {
        const abs = path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
        await writeFile(abs, contents, { mode: 0o600 });
      },
      async close() {},
    };
  }
}

/**
 * 远程传输：把 SshClient 收窄成 ServerTransport。
 * SFTP 能力在这里（闭包持有真 client），调用方拿不到也不该拿 SSH 细节。
 * client 归 SshPool 管理，这里不提供关闭能力（见文件头）。
 */
export function remoteTransport(client: SshClient): ServerTransport {
  return {
    exec: (cmd) => client.exec(cmd),
    sftp: () => openSftp(client),
  };
}

/** 传输层上的文件写入（调用方只用到 write/close） */
export interface ServerSftp {
  write(path: string, contents: string | Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/**
 * 打开文件通道（远程 SFTP / 本机落盘的分派在实现方，见 ServerTransport.sftp）。
 * 调用方纪律不变——写秘密文件前先过 preflight 归属校验。
 */
export function openServerSftp(transport: ServerTransport): Promise<ServerSftp> {
  return transport.sftp();
}
