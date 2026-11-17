# GitHub 授权：GitHub App + 更新触发

> 目标：**构建永远基于最新提交**。主仓库一提交就能触发构建（60s 内），手动触发也必拉最新。

## 凭据模型：App installation token

GitHub App 的身份凭据是**私钥**（不是 PAT）：

```
私钥 PEM ──签 RS256 JWT(iss=App ID, exp≤10min)──▶ POST /app/installations/{id}/access_tokens
                                                        └─▶ installation token（1 小时有效）
```

installation token 权限 = App 被安装到的那些仓库（仓库级授权，不是整个账号）。
同一个 token 两处通用：

| 用途 | 用法 |
|---|---|
| REST API（取最新 sha、读文件、列仓库） | `Authorization: Bearer <token>` |
| git 拉取（远端服务器 clone/fetch） | `https://x-access-token:<token>@github.com/<owner/repo>.git` |

token 1 小时过期，dockyard 在调用前现换现用（提前 5 分钟刷新），远端 fetch 用的是当次现取的 token。

**未配置 App 时回落 gh CLI**（`gh auth token` → `~/.config/gh/hosts.yml`），行为与原来一致；
配了 App 就一律走 App，不再依赖 gh 登录态。

## 建 App 与安装（GitHub 侧，一次性）

1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App
2. 填名字与主页 URL（本地工具随便填即可），回调 URL 留空
3. Repository permissions（最小集）：
   - **Contents: Read-only** —— 读分支最新提交、读文件、git 拉取
   - **Metadata: Read-only** —— 必选（列出安装的仓库靠它）
   - 需要 webhook 时：**Webhooks: Read-only**
4. 生成 Private key（下 `.pem` 文件）→ 记下 **App ID**
5. Install App → 选账号/组织 → 记下 **Installation ID**
6. 需要 webhook 时：App 设置页 Add Webhook → URL 填 `<dockyard 公网入口>/api/github/webhook`，
   Secret 随便设（dockyard 侧填同一个）

> dockyard 本机跑在 3003 端口，GitHub 回调不到——webhook 只有把 dockyard 暴露到公网
> （隧道/反代）时才有意义。**不暴露也能用**：下面的轮询路径本身就满足「提交后 60s 内触发」。

## 在 dockyard 里配置

目前走 API（后续补 UI）：

```sh
# 存凭据（服务端会先换 token 验证，验证不过直接拒绝保存）
curl -X POST http://127.0.0.1:3003/api/github/app \
  -H 'content-type: application/json' \
  -d "{\"appId\":\"123456\",\"installationId\":\"78901234\",\"privateKeyPem\":\"$(cat app.pem | sed 's/\"/\\\\\"/g')\",\"webhookSecret\":\"你的 secret\"}"

# 看状态
curl http://127.0.0.1:3003/api/github/app
# → {"configured":true,"source":"app","appId":"123456","installationId":"78901234","accountLogin":"eastgold15","webhookSecretSet":true}

# 解除授权（删凭据，回落 gh CLI）
curl -X DELETE http://127.0.0.1:3003/api/github/app
```

私钥与 webhook secret 用 enc1（AES-256-GCM，密钥在数据目录）加密落 `github_apps` 表，
不落明文。

## 触发路径：两条，都通

| 路径 | 延迟 | 条件 |
|---|---|---|
| **后台轮询**（默认） | ≤60s | 始终可用；`deployPolicy=auto` 的目标检出更新直接部署，`notify` 只亮徽章 |
| **push webhook** | 秒级 | 需要公网入口 + 配了 webhook secret；只处理分支推送（tag 忽略） |

两条路径共用同一套判定（`updateDecision`）：有已知基线（`lastKnownSha`）且分支 HEAD 变了
=「有更新」。auto 策略按短 sha 防风暴：同一 sha 只自动触发一次，新 sha 才再触发。

## 取码语义：有更新才拉，没有就用缓存

远端服务器 → GitHub 的链路不稳（TLS 抖动会打断整轮部署），而控制面（本地）问 GitHub 可靠。
所以「有没有更新」的判定放在**控制面**：

1. 控制面查上游分支最新 sha（ETag 条件请求，304 = 没变）
2. 与远端现有检出（`git rev-parse HEAD`）比对
3. 相同 → 复用现有检出，**完全不碰远端→GitHub 链路**
4. 不同 → 远端 `git fetch` + `checkout --detach FETCH_HEAD`
5. fetch 瞬时失败重试 3 次；三次都失败 → **不再打死整轮**，沿用远端现有检出继续构建，
   并把「构建的不是最新提交」留在日志里；此时 `updateAvailable` 徽章**保持亮着**
   （`shaStale`），不谎称已部署最新

手动重部署走的是同一条路径——不再依赖 `updateAvailable` 徽章（原来徽章没亮就直接跳过 fetch，
构建的是旧代码）。

## 代码落点

| 关注点 | 文件 |
|---|---|
| 凭据访问（App token / gh 回落 / API 调用 / 仓库列表） | `github/github.service.ts` |
| App 凭据表 + 迁移 | `github/schema.ts` / `github/migrations.ts` |
| 授权状态与 webhook 端点 | `github/github.actions.ts` |
| 更新判定 + 轮询/webhook 触发 | `deploy/update-poller.ts` |
| 取码（判定/拉取/降级） | `deploy/forms.ts` |
