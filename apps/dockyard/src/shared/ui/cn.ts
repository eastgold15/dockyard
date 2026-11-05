// 轻量类名拼接器：忽略空值并展平数组。
// 不负责合并冲突的 Tailwind/Panda 类；变体样式由 Panda recipe 统一定义。
export type ClassValue = string | number | null | undefined | false | ClassValue[]

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = []
  const walk = (v: ClassValue) => {
    if (!v && v !== 0) return
    if (Array.isArray(v)) {
      for (const x of v) walk(x)
    } else {
      out.push(String(v))
    }
  }
  for (const v of inputs) walk(v)
  return out.join(" ")
}
