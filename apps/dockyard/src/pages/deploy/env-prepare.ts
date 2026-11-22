/**
 * 变量绑定：app 从某个来源（库目标 / 共享资源）勾选了哪几个变量。
 *
 * 存引用不存值：绑定只记「哪个来源的哪个键」，值在部署前现取。
 * 库重建换密码后 app 下次部署自动跟随，不会有「变量里躺着过期密码」这种静默失真。
 */
import { envMapToText, textToEnvMap } from "@/shared/env-text";
import type { ProvidedVar } from "@/pages/resources/resources.socket";

export type { ProvidedVar };

/** 来源种类：托管库目标 / 服务器共享资源 */
export type EnvSourceKind = "db" | "shared";

/** 一条绑定：来源 + 勾选的键 + 可选改名 */
export interface EnvBinding {
  sourceKind: EnvSourceKind;
  /** db = deploy_targets.id；shared = resources.id */
  sourceId: number;
  /** 勾选的变量名 */
  keys: string[];
  /** 可选改名：源键 → app 侧键名（不配则同名） */
  rename?: Record<string, string>;
}

/** 一个来源（勾选列表的一行） */
export interface EnvSource {
  sourceKind: EnvSourceKind;
  sourceId: number;
  name: string;
  dbType: string;
  logical: boolean;
  /** 与 app 是否同服务器（跨服务器内网地址不可用） */
  sameServer: boolean;
  /** 建议注入的连接串变量名 */
  envKey: string;
  vars: ProvidedVar[];
  /** 该来源是否可被绑定 */
  bindable: boolean;
}

/** 来源的稳定标识 */
export function sourceKeyOf(source: {
  sourceKind: EnvSourceKind;
  sourceId: number;
}): string {
  return `${source.sourceKind}:${source.sourceId}`;
}

/** 单个键的来源审计 */
export interface EnvAudit {
  /** 最终键名（app 侧） */
  key: string;
  /** 源清单里的键名（rename 时与 key 不同） */
  sourceKey?: string;
  /** 值来源：manual = 手填；binding = 绑定引用 */
  valueFrom: "manual" | "binding";
  sourceKey2?: string;
  status: "applied" | "manual-wins" | "conflict" | "missing";
}

/** 解析结果 */
export interface EffectiveEnv {
  /** 合并后的 .env 文本 */
  envText: string;
  audit: EnvAudit[];
  /** 绑定引用了但来源里没有的键 */
  missing: string[];
}

export interface ResolveInput {
  /** 手填的 .env 文本（envJson） */
  manualText: string;
  /** 绑定列表（按用户保存顺序） */
  bindings: EnvBinding[];
  /** 来源清单：sourceKey → 变量 */
  sources: Map<string, EnvSource>;
}

/**
 * 合并手填与绑定。
 *
 * 优先级：手填 > 绑定（手填是显式的，永远赢）。
 * 绑定之间：先保存的赢（后写的记 conflict，日志点名，不静默覆盖）。
 */
export function resolveEnvBindings(input: ResolveInput): EffectiveEnv {
  const manual = textToEnvMap(input.manualText);
  const audit: EnvAudit[] = [];
  const missing: string[] = [];
  // 目标键 → 已被谁占用（"manual" 或绑定的来源标识）
  const taken = new Map<string, string>();
  for (const key of Object.keys(manual)) taken.set(key, "manual");

  const merged: Record<string, { value: string; secret: boolean }> = {};
  for (const [key, v] of Object.entries(manual)) {
    merged[key] = { value: v.value, secret: false };
    audit.push({ key, valueFrom: "manual", status: "applied" });
  }

  for (const binding of input.bindings) {
    const srcKey = `${binding.sourceKind}:${binding.sourceId}`;
    const source = input.sources.get(srcKey);
    const byKey = new Map((source?.vars ?? []).map((v) => [v.key, v]));
    for (const sourceKey of binding.keys) {
      const entry = byKey.get(sourceKey);
      if (!entry) {
        missing.push(`${srcKey}:${sourceKey}`);
        audit.push({
          key: sourceKey,
          sourceKey,
          valueFrom: "binding",
          sourceKey2: srcKey,
          status: "missing",
        });
        continue;
      }
      const targetKey = binding.rename?.[sourceKey] ?? sourceKey;
      const holder = taken.get(targetKey);
      if (holder === "manual") {
        audit.push({
          key: targetKey,
          sourceKey,
          valueFrom: "manual",
          sourceKey2: srcKey,
          status: "manual-wins",
        });
        continue;
      }
      if (holder !== undefined) {
        audit.push({
          key: targetKey,
          sourceKey,
          valueFrom: "binding",
          sourceKey2: srcKey,
          status: "conflict",
        });
        continue;
      }
      taken.set(targetKey, srcKey);
      merged[targetKey] = { value: entry.value, secret: entry.secret };
      audit.push({
        key: targetKey,
        sourceKey,
        valueFrom: "binding",
        sourceKey2: srcKey,
        status: "applied",
      });
    }
  }

  return { envText: envMapToText(merged), audit, missing };
}

/**
 * 审计摘要（给部署日志用）：只打键名不打值。
 *
 * 秘密值进日志 = 秘密进日志表（明文落库），所以这里严格只输出键名。
 */
export function auditSummary(audit: EnvAudit[]): string[] {
  const lines: string[] = [];
  const manualCount = audit.filter(
    (a) => a.valueFrom === "manual" && a.status === "applied",
  ).length;
  lines.push(`手填：${manualCount} 项`);
  for (const a of audit) {
    if (a.status !== "applied" || a.valueFrom !== "binding") continue;
    lines.push(`   ← ${a.sourceKey2 ?? "绑定"}：${a.key}`);
  }
  for (const a of audit) {
    if (a.status === "manual-wins")
      lines.push(`   手填优先，已覆盖：${a.key}`);
    else if (a.status === "conflict")
      lines.push(`   多个来源都提供 ${a.key}，已用先保存的那个`);
    else if (a.status === "missing")
      lines.push(`   ⚠️ 来源里没有 ${a.sourceKey ?? a.key}，该键未注入`);
  }
  return lines;
}
