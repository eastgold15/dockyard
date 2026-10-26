# dockyard

docker 部署工具——elysiax 页面架构的实战项目。

服务器管理（SSH/密钥/信任）、GitHub 与本地项目导入、compose/openship.json 自动识别、
统一部署引擎（构建/推送/up）、画布编排（React Flow）、反代域名与证书、共享中间件资源。

## 开发

```sh
bun run dev        # elysiax dev（codegen + hot）
bunx elysiax doctor
bunx elysiax build [--desktop]
```

## 架构

- `src/pages/`——原子树：每个原子自含 `schema.ts`/`migrations.ts`/`<name>.socket.ts`，
  跨原子 import 只走插座（doctor 门禁强制）；projects/servers（htmx CRUD）、
  canvas（client 模式整页 React）、deploy/edge/github/resources（纯服务模块）、
  deploy/runtime 与 deploy/backup（嵌套原子）
- `src/app.layout.tsx`——全局壳；`src/shared/`——只剩基建（db/paths/crypto/env-text/ui）
- 文档：[dockyard 实战](../website/docs/dockyard.mdx) · [画布 client 模式](../website/docs/canvas-client.mdx)
