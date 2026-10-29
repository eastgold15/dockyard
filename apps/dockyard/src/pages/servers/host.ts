/**
 * 主机语义（servers 原子内部正主，socket 转出口）。
 * 回环地址 = 本机：本机是程序自己认领的内置资源，不由用户添加。
 *
 * 与 builtin 列的关系：`isLocalHost` 只用于「用户输入是否指向本机」的门禁判定；
 * 运行期通道/画布分区一律以 `server.builtin` 为唯一真相——用户存的
 * `pori@127.0.0.1:2222` 是 SSH 隧道，走远程通道，不是内置本机。
 *
 * 归一化要宽进：大小写、空白、IPv6 方括号、尾点、127/8、RFC 6761 的
 * `*.localhost` 都算回环，避免 `LOCALHOST` / `127.0.0.2` / `[::1]` 绕过门禁。
 */
export const normalizeHost = (host: string): string =>
  host.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");

export const isLocalHost = (host: string): boolean => {
  const h = normalizeHost(host);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1" || h === "::ffff:127.0.0.1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
};
