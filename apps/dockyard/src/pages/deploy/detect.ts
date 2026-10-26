/**
 * 部署自动识别（借鉴 openship 的 overlay 模型：检测先行、声明覆盖）。
 * - 仓库根有 openship.json → 按声明解析（services/domains/env），错误/警告带回 UI
 * - 没有 → 回退解析 compose 文件的 services + ports，生成同样的 DetectResult
 * 形状校验用 typebox（Value.Check 逐项判定），未知字段只警告不报错——同 openship 的宽容策略。
 */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ── openship.json 类型（对齐 tradeflow/openship.json 的实际形状）──
export interface OpenshipEnvValue {
  value: string;
  secret: boolean;
}
export interface OpenshipService {
  name: string;
  exposed: boolean;
  exposedPort?: number;
  domain?: string;
  resources?: { cpuCores?: number; memoryMb?: number; diskMb?: number };
  env: Record<string, OpenshipEnvValue>;
}
export interface OpenshipDomain {
  domain: string;
  port: number;
  type: string; // free | custom
}
export interface OpenshipConfig {
  framework?: string;
  composePath?: string;
  domains: OpenshipDomain[];
  volumes: string[];
  env: Record<string, OpenshipEnvValue>;
  services: OpenshipService[];
}

export interface ParseResult {
  config: OpenshipConfig | null;
  errors: string[];
  warnings: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// ── typebox 形状定义（Value.Check 只做判定，宽容策略：坏项跳过、能救的救回来）──
const EnvValueSchema = Type.Union([
  Type.String(),
  Type.Object({ value: Type.String(), secret: Type.Optional(Type.Boolean()) }),
]);
const DomainSchema = Type.Object({
  domain: Type.String(),
  port: Type.Number(),
  type: Type.Optional(Type.String()),
});
const ResourcesSchema = Type.Object({
  cpuCores: Type.Optional(Type.Number()),
  memoryMb: Type.Optional(Type.Number()),
  diskMb: Type.Optional(Type.Number()),
});
const ServiceNameSchema = Type.Object({ name: Type.String({ minLength: 1 }) });

function parseEnvValue(key: string, raw: unknown, warnings: string[]): OpenshipEnvValue | null {
  if (!Value.Check(EnvValueSchema, raw)) {
    warnings.push(`env.${key} 形状无法识别，已跳过`);
    return null;
  }
  return typeof raw === "string"
    ? { value: raw, secret: false }
    : { value: raw.value, secret: raw.secret === true };
}

function parseEnvMap(raw: unknown, scope: string, warnings: string[]): Record<string, OpenshipEnvValue> {
  const out: Record<string, OpenshipEnvValue> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const parsed = parseEnvValue(`${scope}.${k}`, v, warnings);
    if (parsed) out[k] = parsed;
  }
  return out;
}

/** 手写宽容解析器：坏字段进 errors，未知字段进 warnings，能救的都救回来 */
export function parseOpenshipConfig(raw: unknown): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(raw)) return { config: null, errors: ["openship.json 顶层必须是对象"], warnings };

  const KNOWN = new Set(["$schema", "framework", "composePath", "domains", "volumes", "env", "services", "resources"]);
  for (const key of Object.keys(raw)) if (!KNOWN.has(key)) warnings.push(`未知字段 ${key}（忽略）`);

  const domains: OpenshipDomain[] = [];
  if (raw.domains !== undefined) {
    if (!Array.isArray(raw.domains)) errors.push("domains 必须是数组");
    else {
      for (const [i, d] of raw.domains.entries()) {
        if (!Value.Check(DomainSchema, d)) {
          errors.push(`domains[${i}] 需要 { domain: string, port: number }`);
          continue;
        }
        const dd = d as Static<typeof DomainSchema>;
        domains.push({ domain: dd.domain, port: dd.port, type: dd.type ?? "custom" });
      }
    }
  }

  const services: OpenshipService[] = [];
  if (raw.services !== undefined) {
    if (!Array.isArray(raw.services)) errors.push("services 必须是数组");
    else {
      for (const [i, s] of raw.services.entries()) {
        if (!Value.Check(ServiceNameSchema, s)) {
          errors.push(`services[${i}] 需要 name: string`);
          continue;
        }
        const svc = s as Static<typeof ServiceNameSchema> & Obj;
        services.push({
          name: svc.name,
          exposed: svc.exposed === true,
          exposedPort: typeof svc.exposedPort === "string" ? Number(svc.exposedPort) || undefined
            : typeof svc.exposedPort === "number" ? svc.exposedPort : undefined,
          domain: typeof svc.domain === "string" ? svc.domain : undefined,
          resources: Value.Check(ResourcesSchema, svc.resources) ? svc.resources : undefined,
          env: parseEnvMap(svc.env, `services.${svc.name}.env`, warnings),
        });
      }
    }
  }

  const volumes: string[] = [];
  if (raw.volumes !== undefined) {
    if (!Array.isArray(raw.volumes)) warnings.push("volumes 应为字符串数组，已忽略");
    else for (const v of raw.volumes) typeof v === "string" ? volumes.push(v) : warnings.push(`volumes 里的非字符串项已忽略`);
  }

  return {
    config: {
      framework: typeof raw.framework === "string" ? raw.framework : undefined,
      composePath: typeof raw.composePath === "string" ? raw.composePath : undefined,
      domains,
      volumes,
      env: parseEnvMap(raw.env, "env", warnings),
      services,
    },
    errors,
    warnings,
  };
}

export function parseOpenshipConfigJson(text: string): ParseResult {
  try {
    return parseOpenshipConfig(JSON.parse(text));
  } catch (e) {
    return { config: null, errors: [`openship.json 不是合法 JSON：${(e as Error).message}`], warnings: [] };
  }
}

// ── UI/创建共用的识别结果（openship.json 与 compose 回退统一成这个形状）──
export interface DetectedService {
  name: string;
  exposed: boolean;
  port?: number; // 对外端口
  domain?: string;
  cpuCores?: number;
  memoryMb?: number;
  image?: string; // compose 探测时捕获（共享资源匹配用：识别 postgres/redis 等中间件）
  env: Record<string, OpenshipEnvValue>;
}

/** 从服务 image / 名称猜测中间件类型（部署前置检查：对比服务器共享资源清单） */
export function guessDbType(svc: { name: string; image?: string }): "postgres" | "mysql" | "redis" | "mongo" | null {
  const hay = `${svc.image ?? ""} ${svc.name}`.toLowerCase();
  if (/postgres|pgvector|postgis/.test(hay)) return "postgres";
  if (/mysql|mariadb/.test(hay)) return "mysql";
  if (/redis|valkey|dragonfly/.test(hay)) return "redis";
  if (/mongo/.test(hay)) return "mongo";
  return null;
}
export interface DetectResult {
  source: "openship.json" | "compose" | "none";
  composePath: string;
  services: DetectedService[];
  rootEnv: Record<string, OpenshipEnvValue>;
  errors: string[];
  warnings: string[];
}

/** openship.json → DetectResult（services[] 为空时退回 compose 探测端口） */
export function configToDetect(parsed: ParseResult, composeText: string | null): DetectResult {
  const { config, errors, warnings } = parsed;
  if (!config) return { source: "openship.json", composePath: "docker-compose.yml", services: [], rootEnv: {}, errors, warnings };
  const composePath = config.composePath ?? "docker-compose.yml";
  const domainByPort = new Map(config.domains.map((d) => [d.port, d.domain]));
  let services: DetectedService[] = config.services.map((s) => ({
    name: s.name,
    exposed: s.exposed,
    port: s.exposedPort ?? (s.exposed ? domainByPortPort(config.domains, s.domain) : undefined),
    domain: s.domain,
    cpuCores: s.resources?.cpuCores,
    memoryMb: s.resources?.memoryMb,
    env: s.env,
  }));
  if (services.length === 0 && composeText) {
    services = detectFromCompose(composeText).services;
    warnings.push("openship.json 未声明 services，已从 compose 探测");
  }
  // domains[] 里未被任何 service 认领的，按端口挂到同名/同端口 exposed 服务
  for (const d of config.domains) {
    if (services.some((s) => s.domain === d.domain)) continue;
    const svc = services.find((s) => s.exposed && s.port === d.port) ?? services.find((s) => s.exposed);
    if (svc) {
      svc.domain = svc.domain ?? d.domain;
      svc.port = svc.port ?? d.port;
    } else {
      warnings.push(`域名 ${d.domain}:${d.port} 没有可挂靠的 exposed 服务`);
    }
  }
  return { source: "openship.json", composePath, services, rootEnv: config.env, errors, warnings };
}

function domainByPortPort(domains: OpenshipDomain[], domain?: string): number | undefined {
  if (!domain) return undefined;
  return domains.find((d) => d.domain === domain)?.port;
}

/** compose 里的 env_file 相对路径（远端没有仓库目录树，up 前需要占位文件兜底，否则 compose 直接报错）。
 *  "${ENV:-production}" 这类默认值占位符按默认值展开。 */
export function envFilePaths(composeText: string): string[] {
  let doc: unknown;
  try {
    doc = parseYaml(composeText);
  } catch {
    return [];
  }
  const svcs = isObj(doc) && isObj(doc.services) ? doc.services : {};
  const paths = new Set<string>();
  for (const def of Object.values(svcs)) {
    if (!isObj(def)) continue;
    const raw = def.env_file;
    const list = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
    for (const item of list) {
      const p = typeof item === "string" ? item : isObj(item) && typeof item.path === "string" ? item.path : null;
      if (!p) continue;
      const expanded = p.replace(/\$\{[^}]*:-([^}]*)\}/g, "$1");
      if (!expanded.startsWith("/") && !expanded.includes("${")) paths.add(expanded);
    }
  }
  return [...paths];
}

/** compose 回退：只探测 services 和 ports（格式 "host:container" 或 "port"），env 不猜 */
export function detectFromCompose(composeText: string): DetectResult {
  const warnings: string[] = [];
  const services: DetectedService[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(composeText);
  } catch (e) {
    return { source: "compose", composePath: "docker-compose.yml", services: [], rootEnv: {}, errors: [`compose 解析失败：${(e as Error).message}`], warnings };
  }
  const svcs = isObj(doc) && isObj(doc.services) ? doc.services : {};
  for (const [name, def] of Object.entries(svcs)) {
    if (!isObj(def)) continue;
    let port: number | undefined;
    if (Array.isArray(def.ports)) {
      // "${API_PORT:-13080}:${API_PORT:-13080}" → 取默认值再匹配 "host:container"
      const first = String(def.ports[0]).replace(/\$\{[^}]*:-(\d+)\}/g, "$1");
      const m = first.match(/^(?:(\d+):)?(\d+)(?:\/(?:tcp|udp))?$/);
      if (m) port = Number(m[1] ?? m[2]);
    }
    if (def.image === undefined && def.build === undefined) warnings.push(`服务 ${name} 既无 image 也无 build，部署可能失败`);
    services.push({ name, exposed: port !== undefined, port, image: typeof def.image === "string" ? def.image : undefined, env: {} });
  }
  if (services.length === 0) warnings.push("compose 里没发现任何 service");
  return { source: "compose", composePath: "docker-compose.yml", services, rootEnv: {}, errors: [], warnings };
}

import { envMapToText } from "../../shared/env-text";

// env 文本转换函数抽到了零依赖的 env-text.ts（canvas client 也要打包），此处转出口保持旧 import 不破
export { serviceEnvToText, textToEnvMap } from "../../shared/env-text";

/** rootEnv → .env 文本（服务 compose 的 ${VAR} 插值；服务级变量走 override 的 environment，不扁平化） */
export function detectToEnvText(detect: Pick<DetectResult, "rootEnv">): string {
  return envMapToText(detect.rootEnv);
}

/** 资源限制 + 服务级 environment → compose override。
 *  environment 是 openship.json 服务 env 真正送达容器的通道（用户 compose 的 env_file 相对路径远端不存在）；
 *  资源限制对应 openship 的 HostConfig.NanoCpus/Memory（compose 里是 cpus/mem_limit）。
 *  不写 name: —— 远端 up 用 -p 定死项目名，override 里的 name 反而会抢。
 *  含秘密值，落库前必须 enc1: 加密。 */
export function detectToOverrideCompose(detect: Pick<DetectResult, "services">): string | null {
  const services: Record<string, Record<string, unknown>> = {};
  for (const s of detect.services) {
    const def: Record<string, unknown> = {};
    if (s.cpuCores) def.cpus = s.cpuCores;
    if (s.memoryMb) def.mem_limit = `${s.memoryMb}m`;
    const env = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, v.value]));
    if (Object.keys(env).length > 0) def.environment = env;
    if (Object.keys(def).length > 0) services[s.name] = def;
  }
  if (Object.keys(services).length === 0) return null;
  return stringifyYaml({ services });
}

// ── 识别入口（原 DeployService.detectRepo/detectLocal，下沉为纯函数）──
import { join } from "node:path";
import { parseOwnerRepo, type GithubService } from "../github/github.socket";

/** 仓库识别：gh contents API 直读文件（不克隆，秒级）→ openship.json 声明覆盖 → compose 回退 */
export async function detectRepo(github: GithubService, input: { repoUrl: string; branch: string }): Promise<DetectResult> {
  const ownerRepo = parseOwnerRepo(input.repoUrl);
  const branch = input.branch || "main";
  const read = (path: string) => github.fileContent(ownerRepo, path, branch);

  const openshipText = await read("openship.json");
  if (openshipText !== null) {
    const parsed = parseOpenshipConfigJson(openshipText);
    const composePath = parsed.config?.composePath ?? "docker-compose.yml";
    return configToDetect(parsed, await read(composePath));
  }
  for (const candidate of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    const text = await read(candidate);
    if (text !== null) {
      const result = detectFromCompose(text);
      result.composePath = candidate;
      return result;
    }
  }
  return {
    source: "none",
    composePath: "docker-compose.yml",
    services: [],
    rootEnv: {},
    errors: [],
    warnings: ["仓库里既没有 openship.json 也没有 compose 文件，请手动填写部署参数"],
  };
}

/** 本地文件夹导入的识别：直接读本机目录的 openship.json / compose（不走 GitHub API） */
export async function detectLocal(input: { localPath: string; rootDir?: string }): Promise<DetectResult> {
  const dir = join(input.localPath, input.rootDir ?? "");
  const read = async (path: string): Promise<string | null> => {
    const file = Bun.file(join(dir, path));
    return (await file.exists()) ? file.text() : null;
  };
  const openshipText = await read("openship.json");
  if (openshipText !== null) {
    const parsed = parseOpenshipConfigJson(openshipText);
    const composePath = parsed.config?.composePath ?? "docker-compose.yml";
    return configToDetect(parsed, await read(composePath));
  }
  for (const candidate of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    const text = await read(candidate);
    if (text !== null) {
      const result = detectFromCompose(text);
      result.composePath = candidate;
      return result;
    }
  }
  return {
    source: "none",
    composePath: "docker-compose.yml",
    services: [],
    rootEnv: {},
    errors: [],
    warnings: ["本地目录里既没有 openship.json 也没有 compose 文件，请手动填写部署参数"],
  };
}
