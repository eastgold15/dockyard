/**
 * 主机语义（servers 原子内部正主，socket 转出口）。
 * 回环地址 = 本机：本机是程序自己认领的内置资源，不由用户添加。
 */
export const isLocalHost = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "::1";
