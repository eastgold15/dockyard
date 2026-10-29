/**
 * 容器发现（只读）：把 docker 里「不是 dockyard 管理」的容器上画。
 *
 * 语义边界：发现 ≠ 纳管。发现卡不参与部署/回滚/备份，只是让世界地图诚实地
 * 显示服务器上跑着什么；真正纳管仍走「添加应用 / 添加数据库」。
 *
 * 项目归属不是猜名字，而是用 compose 的 working_dir 反查项目的 localPath
 * （tradeflow 的容器 working_dir = <repo>/deploy → 归到 tradeflow）。
 * 名字前缀/ compose project 名只作兜底。
 */
import type { DiscoveredContainer } from "./canvas.model";

/** dockerode ContainerInfo 的最小子集（单测可直接造） */
export interface RawContainer {
  Id: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Labels?: Record<string, string>;
  Ports?: { PrivatePort?: number; PublicPort?: number; Type?: string; IP?: string }[];
}

export interface ProjectRef {
  id: number;
  name: string;
  slug: string;
  localPath: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[-_\s]/g, "");

/** 容器 → dockyard 项目 id；匹配不到返回 null（只在世界视图显示） */
export function matchProjectId(
  container: Pick<RawContainer, "Names" | "Labels">,
  projects: ProjectRef[],
): number | null {
  const labels = container.Labels ?? {};
  const name = (container.Names?.[0] ?? "").replace(/^\//, "");

  // 1) compose working_dir 落在项目 localPath 内（最长前缀胜出，防嵌套仓库误配）
  const workDir = labels["com.docker.compose.project.working_dir"];
  if (workDir) {
    let best: ProjectRef | null = null;
    for (const p of projects) {
      if (!p.localPath) continue;
      if (workDir !== p.localPath && !workDir.startsWith(`${p.localPath}/`)) continue;
      if (!best || p.localPath.length > best.localPath!.length) best = p;
    }
    if (best) return best.id;
  }

  // 2) dockyard 自己打的标签（历史容器）
  const tagged = labels["dockyard.project"];
  if (tagged) {
    const hit = projects.find((p) => p.slug === tagged || p.name === tagged);
    if (hit) return hit.id;
  }

  // 3) compose project 名
  const composeProject = labels["com.docker.compose.project"];
  if (composeProject) {
    const hit = projects.find(
      (p) => norm(p.slug) === norm(composeProject) || norm(p.name) === norm(composeProject),
    );
    if (hit) return hit.id;
  }

  // 4) 容器名前缀：tradeflow_postgres → tradeflow
  const prefix = name.split(/[_-]/)[0];
  if (prefix) {
    const hit = projects.find(
      (p) => norm(p.slug) === norm(prefix) || norm(p.name) === norm(prefix),
    );
    if (hit) return hit.id;
  }
  return null;
}

/** 端口摘要：5444→5432/tcp, 6379→6379/tcp（同一私有端口有公网映射时不再单列裸端口） */
export function portsSummary(ports: RawContainer["Ports"]): string {
  const exposed = new Set(ports?.filter((p) => p.PrivatePort && p.PublicPort).map((p) => p.PrivatePort));
  const seen = new Set<string>();
  for (const p of ports ?? []) {
    if (!p.PrivatePort) continue;
    const proto = p.Type ?? "tcp";
    if (!p.PublicPort && exposed.has(p.PrivatePort)) continue;
    seen.add(p.PublicPort ? `${p.PublicPort}→${p.PrivatePort}/${proto}` : `${p.PrivatePort}/${proto}`);
  }
  return [...seen].join(", ");
}

/**
 * 原始容器列表 → 发现模型。
 * 过滤：dockyard 管理的（已有卡片）、compose one-off（docker compose run 的一次性任务）。
 */
export function discoverContainers(
  containers: RawContainer[],
  projects: ProjectRef[],
): DiscoveredContainer[] {
  return containers
    .filter((c) => c.Labels?.["dockyard.managed"] !== "true")
    .filter((c) => c.Labels?.["com.docker.compose.oneoff"] !== "True")
    .map((c) => {
      const name = (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, "");
      return {
        id: c.Id.slice(0, 12),
        name,
        service: c.Labels?.["com.docker.compose.service"] ?? "",
        composeProject: c.Labels?.["com.docker.compose.project"] ?? "",
        image: c.Image ?? "",
        state: (c.State ?? "unknown") as DiscoveredContainer["state"],
        ports: portsSummary(c.Ports),
        projectId: matchProjectId(c, projects),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
