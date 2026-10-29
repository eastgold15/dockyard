/**
 * 容器发现纯函数单测：过滤 dockyard 纳管/one-off、working_dir 反查项目、
 * 兜底匹配（compose project 名 / 容器名前缀）、端口摘要。
 */
import { expect, test } from "bun:test";
import { discoverContainers, discoverySignature, matchProjectId, portsSummary } from "./discovery";
import type { RawContainer } from "./discovery";

const projects = [
  { id: 6, name: "tradeflow", slug: "tradeflow", localPath: "/home/pori/Documents/GitHub/tradeflow" },
  { id: 7, name: "elysiax", slug: "elysiax", localPath: "/home/pori/Documents/GitHub/elysiax" },
  { id: 8, name: "tradeflow-nested", slug: "tradeflow-nested", localPath: "/home/pori/Documents/GitHub/tradeflow/sub" },
];

const pg: RawContainer = {
  Id: "abcdef1234567890",
  Names: ["/tradeflow_postgres"],
  Image: "postgres:17-alpine",
  State: "running",
  Labels: {
    "com.docker.compose.project": "deploy",
    "com.docker.compose.service": "postgres",
    "com.docker.compose.project.working_dir": "/home/pori/Documents/GitHub/tradeflow/deploy",
    "com.docker.compose.oneoff": "False",
  },
  Ports: [
    { PrivatePort: 5432, PublicPort: 5444, Type: "tcp" },
    { PrivatePort: 5432, Type: "tcp" },
  ],
};

test("working_dir 落在项目 localPath 内 → 归属该项目", () => {
  expect(matchProjectId(pg, projects)).toBe(6);
});

test("最长前缀胜出（嵌套仓库不误配）", () => {
  const nested: RawContainer = {
    Id: "x",
    Names: ["/sub_container"],
    Labels: { "com.docker.compose.project.working_dir": "/home/pori/Documents/GitHub/tradeflow/sub/deploy" },
  };
  expect(matchProjectId(nested, projects)).toBe(8);
});

test("兜底：compose project 名 / 容器名前缀匹配", () => {
  const byProject: RawContainer = {
    Id: "y",
    Names: ["/db"],
    Labels: { "com.docker.compose.project": "elysiax" },
  };
  expect(matchProjectId(byProject, projects)).toBe(7);
  const byPrefix: RawContainer = { Id: "z", Names: ["/tradeflow_redis"] }; // 无 compose 标签的裸容器
  expect(matchProjectId(byPrefix, projects)).toBe(6);
  // 有 compose 标签但项目名不匹配：不能再按名字前缀猜（否则会被挂到同名项目下）
  const composeMismatch: RawContainer = {
    Id: "z2",
    Names: ["/tradeflow_redis"],
    Labels: { "com.docker.compose.project": "deploy" },
  };
  expect(matchProjectId(composeMismatch, projects)).toBeNull();
});

test("匹配不到 → null（只在世界视图显示）", () => {
  const other: RawContainer = { Id: "w", Names: ["/random-worker"], Labels: { "com.docker.compose.project": "deploy" } };
  expect(matchProjectId(other, projects)).toBeNull();
});

test("discoverContainers：过滤 dockyard 纳管与一次性容器，端口去重", () => {
  const managed: RawContainer = {
    Id: "m",
    Names: ["/dockyard-x"],
    Labels: { "dockyard.managed": "true", "com.docker.compose.project": "dockyard-1" },
  };
  const oneoff: RawContainer = {
    Id: "o",
    Names: ["/tradeflow_postgres_run_1"],
    Labels: { "com.docker.compose.oneoff": "True", "com.docker.compose.project": "deploy" },
  };
  const out = discoverContainers([pg, managed, oneoff], projects);
  expect(out.map((d) => d.name)).toEqual(["tradeflow_postgres"]);
  expect(out[0]).toMatchObject({
    id: "abcdef123456",
    service: "postgres",
    composeProject: "deploy",
    image: "postgres:17-alpine",
    state: "running",
    ports: "5444→5432/tcp",
    projectId: 6,
    projectName: "tradeflow",
  });
});

test("discoverySignature：未纳管容器指纹，与顺序无关（poller 变更检测用）", () => {
  const managed: RawContainer = { Id: "managed00001", Labels: { "dockyard.managed": "true" } };
  const other: RawContainer = { Id: "zzz", Labels: {} }; // state 缺省记 unknown
  expect(discoverySignature([pg, managed])).toBe("abcdef123456:running");
  expect(discoverySignature([pg, other])).toBe("abcdef123456:running,zzz:unknown");
  expect(discoverySignature([other, pg])).toBe("abcdef123456:running,zzz:unknown");
  expect(discoverySignature([managed])).toBe("");
});

test("portsSummary：无公网映射只写私有端口", () => {
  expect(portsSummary([{ PrivatePort: 6379, Type: "tcp" }])).toBe("6379/tcp");
  expect(portsSummary(undefined)).toBe("");
});
