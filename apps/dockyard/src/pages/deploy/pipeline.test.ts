/**
 * 部署流水线命令/标签单测（本机部署冒烟暴露的回归点）：
 * - 归属标签必须在 up 的同一批 -f 里创建（否则重部署 preflight 把自家容器当别人的）
 * - up 必须 --force-recreate（同名镜像 tag 重建后 compose 不会自动重建容器）
 * - 部署后回写 compose 项目名（运行时容器对账全靠它）
 */
import { expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import type { DeployTarget } from "./schema";
import { composeUpCommand, inspectCompose, ownershipCompose, type Harness } from "./pipeline";

test("ownershipCompose：为空返回 undefined，否则每个服务都带 managed/target-id", () => {
  expect(ownershipCompose(7, [])).toBeUndefined();
  const doc = parseYaml(ownershipCompose(7, ["web", "db"])!) as {
    services: Record<string, { labels: Record<string, string> }>;
  };
  expect(Object.keys(doc.services)).toEqual(["web", "db"]);
  expect(doc.services.web!.labels).toEqual({ "dockyard.managed": "true", "dockyard.target-id": "7" });
  expect(doc.services.db!.labels["dockyard.managed"]).toBe("true");
});

test("composeUpCommand：-p/-f/服务子集都在，且强制重建", () => {
  const cmd = composeUpCommand({
    dir: "/srv/app",
    project: "myproj",
    files: '-f "docker-compose.yml" -f docker-compose.dockyard-labels.yml',
    upServices: ["web"],
  });
  expect(cmd).toBe(
    'cd "/srv/app" && docker compose -p myproj -f "docker-compose.yml" -f docker-compose.dockyard-labels.yml up -d --force-recreate web',
  );
  // 无项目名/文件/子集时也不能丢 --force-recreate
  expect(composeUpCommand({ dir: "/srv/db" })).toBe('cd "/srv/db" && docker compose up -d --force-recreate');
  // 只有「本次镜像/配置没变」的形态（db 模板）才显式关掉强制重建
  expect(composeUpCommand({ dir: "/srv/db", forceRecreate: false })).toBe('cd "/srv/db" && docker compose up -d');
});

test("inspectCompose：标签层压轴、容器名对账用 container_name 优先", async () => {
  let checked: string[] = [];
  const h = {
    sshExec: async () => ({
      code: 0,
      stdout: JSON.stringify({
        name: "remote",
        services: { web: { image: "app:dev" }, db: { container_name: "mydb", image: "pg:17" } },
      }),
      stderr: "",
    }),
    preflightCheck: async (_t: DeployTarget, _s: number, names: string[]) => {
      checked = names;
    },
  } as unknown as Harness;
  const out = await inspectCompose(h, {
    target: { id: 7 } as DeployTarget,
    serverId: 1,
    remoteDir: "/srv/app",
    composeFile: "docker-compose.yml",
    hasOverride: true,
    log: async () => {},
  });
  expect(out.project).toBe("remote");
  expect(checked).toEqual(["remote-web-1", "mydb"]);
  expect(out.composeArgs).toBe(
    '-f "docker-compose.yml" -f docker-compose.dockyard.yml -f docker-compose.dockyard-labels.yml',
  );
  const labels = parseYaml(out.labelsCompose!) as {
    services: Record<string, { labels: Record<string, string> }>;
  };
  expect(labels.services.web!.labels["dockyard.target-id"]).toBe("7");
});
