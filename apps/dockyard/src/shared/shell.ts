/**
 * 跨原子共用的 shell 拼接助手。
 * 远端/本机命令里的用户可控片段（路径、容器名）必须先过这里：
 * POSIX 单引号内除 `'` 外一切字符都无特殊含义，`'` 用 `'\''` 断开转义。
 */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
