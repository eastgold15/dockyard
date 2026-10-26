/**
 * .env 文本 ⇄ env map 的纯函数模块（零依赖，浏览器可打包）。
 * canvas client（React 抽屉）与服务端 detect/deploy 共用；
 * dotenv 的 browser dist 会 require("child_process")，Bun 浏览器打包直接挂，
 * 所以这里实现最小的解析/序列化（引号、转义、注释、export 前缀）。
 */
/** 与 detect 的 OpenshipEnvValue 结构一致（本地定义保持本模块零依赖） */
export interface EnvValue {
  value: string;
  secret: boolean;
}

/** 含空白/引号/# 的值按 dotenv 双引号规则转义 */
function quoteEnv(value: string): string {
  return /[\s#"']/.test(value) ? JSON.stringify(value) : value;
}

/** env map → .env 文本 */
export function envMapToText(env: Record<string, EnvValue>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${quoteEnv(v.value)}`).join("\n");
}

/** 服务 env map → .env 文本（step2 服务卡片编辑框初值；envMapToText 别名） */
export const serviceEnvToText = envMapToText;

/** 双引号串内 \" \\ \n 转义还原 */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

/** .env 文本 → env map（KEY=VALUE 行；# 注释、export 前缀、单/双引号） */
export function textToEnvMap(text: string): Record<string, EnvValue> {
  const out: Record<string, EnvValue> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!;
    // 无引号时去掉行尾注释（值里 # 前有空白才算注释）
    if (!/^["']/.test(value)) value = value.replace(/\s+#.*$/, "").trim();
    else value = value.trim();
    out[key] = { value: unquote(value), secret: false };
  }
  return out;
}
