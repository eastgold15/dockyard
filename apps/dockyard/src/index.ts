// 必须置顶：Elysia 内部惰性 require("typebox/*")，bun --compile 无法静态分析，
// 这里显式 import 强制把 typebox 打进二进制（否则编译产物启动即挂）
import "typebox/type";
import "typebox/system";
import "typebox/value";
import "typebox/schema";
import "typebox/compile";

import { start, type ServiceSpecs } from "@elysiax/core";
import type { Container } from "@inferdi/inferdi";
import "./app.layout";
import * as gen from "../.elysiax";
import type { ServiceMap } from "../.elysiax";

const { root } = await start({
  port: 3003,
  gen,
  api: {
    // OpenAPI 文档：/openapi（Scalar UI）。运行时路由注册表生成 spec，
    // 端点都有显式 t schema，无需 fromTypes
    openapi: { documentation: { info: { title: "dockyard API", version: "0.1.0" } } },
  },
});

// 后台轮询器与请求共用同一个根容器（DI 服务单例：SSH 连接池只有一份）
const di = root as Container<ServiceSpecs<ServiceMap>>;
// GitHub 更新轮询：只提示不自动部署
di.get("updatePoller").start();
// 容器状态轮询 → 事件总线 → SSE：SSH 频率与前端用户数无关
di.get("containerPoller").start();
