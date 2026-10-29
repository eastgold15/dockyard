/**
 * 域名白名单：hostname 会进 Caddy 配置、DNS 查询和远端 curl 命令。
 * 归一化必须发生在查重之前（Example.COM. 与 example.com 是同一个域名）。
 */
import { expect, test } from "bun:test";
import { ServiceError } from "@elysiax/core";
import { assertSafeHostname, normalizeHostname } from "./edge.service";

test("normalizeHostname：去空白、小写、去尾点", () => {
  expect(normalizeHostname("  Example.COM. ")).toBe("example.com");
  expect(normalizeHostname("api.example.com")).toBe("api.example.com");
});

test("assertSafeHostname：合法域名通过", () => {
  for (const ok of ["example.com", "api.example.com", "a-b.example.co.uk", "x.y"]) {
    expect(() => assertSafeHostname(ok)).not.toThrow();
  }
});

test("assertSafeHostname：拒绝空标签/单标签/空格/引号/下划线/路径", () => {
  for (const bad of ["", "localhost", "a..b", "-a.com", "a-.com", "exa mple.com", "a'b.com", "a_b.com", "example.com/x", "example.com;id"]) {
    expect(() => assertSafeHostname(bad)).toThrow(ServiceError);
  }
});
