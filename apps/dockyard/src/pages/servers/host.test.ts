/**
 * 主机门禁单测：isLocalHost 只用于「用户输入是否指向本机」（运行期通道以 builtin 为准）。
 * 归一化必须挡住大小写/空白/IPv6 方括号/尾点/127.0.0.2 这些绕过手法。
 */
import { expect, test } from "bun:test";
import { isLocalHost, normalizeHost } from "./host";

test("normalizeHost：去空白、小写、尾点、IPv6 方括号", () => {
  expect(normalizeHost("  LOCALHOST. ")).toBe("localhost");
  expect(normalizeHost("[::1]")).toBe("::1");
  expect(normalizeHost("[::1].")).toBe("::1");
  expect(normalizeHost("10.0.0.5")).toBe("10.0.0.5");
});

test("isLocalHost：回环的各种写法", () => {
  for (const host of [
    "localhost",
    "LOCALHOST",
    " localhost ",
    "localhost.",
    "app.localhost",
    "127.0.0.1",
    "127.0.0.2",
    "[::1]",
    "::1",
    "::ffff:127.0.0.1",
  ]) {
    expect(isLocalHost(host)).toBe(true);
  }
});

test("isLocalHost：名字里带 localhost 但不是回环域的不算", () => {
  for (const host of ["localhost.example.com", "127.acme.com", "10.0.0.5", "192.168.1.2"]) {
    expect(isLocalHost(host)).toBe(false);
  }
});
