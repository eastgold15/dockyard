/**
 * 本机传输单测：本地进程执行（stdout/stderr/exit code）+ 本机文件通道直写。
 * 不碰网络、不碰 SSH。
 */
import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTransport, openServerSftp, type ServerTransport } from "./transport";

test("LocalTransport.exec：stdout 与退出码透传", async () => {
  const t = new LocalTransport();
  const r = await t.exec("printf hi");
  expect(r.stdout).toBe("hi");
  expect(r.code).toBe(0);
  expect(t.local).toBe(true);
});

test("LocalTransport.exec：非零退出码与 stderr", async () => {
  const t = new LocalTransport();
  const r = await t.exec("echo boom >&2; exit 3");
  expect(r.code).toBe(3);
  expect(r.stderr.trim()).toBe("boom");
});

test("openServerSftp：分派到 transport.sftp()（远程包装对象不能被强转回 SshClient）", async () => {
  // 远程通道只有 exec/close/sftp：断言 openServerSftp 不碰 SSH 细节，
  // 否则远端会抛 TypeError: client.session is not a function（本机测试跑不到那条路径）
  const written: { path: string; contents: string | Uint8Array }[] = [];
  const fake: ServerTransport = {
    local: false,
    exec: async () => ({ stdout: "", stderr: "", code: 0, signal: null, coreDumped: null, errorMessage: null }),
    close: async () => {},
    sftp: async () => ({
      write: async (path, contents) => { written.push({ path, contents }); },
      close: async () => {},
    }),
  };
  const sftp = await openServerSftp(fake);
  await sftp.write("~/x.yml", "a: 1");
  expect(written).toEqual([{ path: "~/x.yml", contents: "a: 1" }]);
});

test("openServerSftp：本机直接落盘（不建 SFTP 会话）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dockyard-local-sftp-"));
  const file = join(dir, "docker-compose.yml");
  const sftp = await openServerSftp(new LocalTransport());
  await sftp.write(file, "services: {}\n");
  await sftp.close();
  expect(await readFile(file, "utf8")).toBe("services: {}\n");
});
