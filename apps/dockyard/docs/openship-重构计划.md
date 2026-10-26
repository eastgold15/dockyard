# Openship 重构计划

> 依据《Openship 项目完整需求文档》对 dockyard 的重构。本地桌面客户端、无账号、密钥全在本地；双导入（GitHub / 本地文件夹）、双视角部署、服务器共享资源复用。

## 差距分析

已具备：双导入项目记录、openship.json 解析（detect.ts）、中间件模板、统一部署引擎（本地构建→镜像推送→compose up）、画布四类节点+依赖连线、env 加密、域名/监控。

缺口：
1. 服务器共享资源清单（跨项目复用、复用询问、共享变量下拉）
2. 本地文件夹直接部署路径
3. GitHub 远端构建路径（服务器拉代码+构建）
4. 服务卡片六 Tab（Source/Hardware/Network/Env/Monitor/Console）+ 容器终端
5. 命名服务分组（画布容器）

## 里程碑

### M1 数据模型
- `server_resources`：id, serverId, name, dbType, containerName, envKey(如 DATABASE_URL), credsJson(enc1 加密，含连接串/密码), createdAt
- `projects` += sourceType("github"|"local"), branch, rootDir
- `service_groups`：id, nodeId, name, x, y, w, h
- `deploy_targets` += groupId（可空）

### M2 共享资源（视角 B）
- 服务器卡直接部署中间件到服务器（不依赖项目节点），复用 db-templates
- 部署成功生成连接串 → 写 server_resources
- 资源清单 CRUD + UI（服务器卡/设置页）

### M3 本地文件夹部署
- deployApp 分支：project.sourceType === "local" → 从 localPath 直接 docker compose build（跳过 git clone），后续 docker save → 远端 load → compose up 复用

### M4 GitHub 远端构建
- sourceType === "github" → SSH 远端 git clone/pull + 服务器上 docker compose build + up（不再本地构建推镜像）

### M5 部署前置检查 + 复用弹窗（视角 A）
- 「部署本项目」：读 openship.json 服务清单 → 对比 server_resources → 匹配则弹窗询问复用
- 复用：过滤中间件服务，注入共享变量；不复用/无匹配：完整部署

### M6 六 Tab + Console + 分组
- 服务抽屉改 Source / Hardware / Network / Env / Monitor / Console
- Console：Elysia WebSocket + dockerode exec TTY + xterm.js
- Env Tab：共享变量下拉引用（server_resources.envKey）
- 画布命名服务分组（service_groups 容器节点）

## 统一规则
两种导入、双视角共用同一部署引擎，仅「代码获取 + 镜像构建」按 sourceType 分支。
