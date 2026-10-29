/**
 * 本机传输单测：本地进程执行（stdout/stderr/exit code）+ 本机文件通道直写。
 * 不碰网络、不碰 SSH。
 */
import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTransport, openServerSftp } from "./transport";

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

test("openServerSftp：本机直接落盘（不建 SFTP 会话）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dockyard-local-sftp-"));
  const file = join(dir, "docker-compose.yml");
  const sftp = await openServerSftp(new LocalTransport());
  await sftp.write(file, "services: {}\n");
  await sftp.close();
  expect(await readFile(file, "utf8")).toBe("services: {}\n");
});
