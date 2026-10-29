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
// 内置本机：程序自己认领（固定 127.0.0.1 + 当前系统用户，本地进程直连）；
// 旧版本用户添加的回环行原地升级为内置行（保留 id，画布卡/部署目标外键不断）
const local = await di.get("serverService").ensureLocal();
// 启动即检测本机 docker：徽章/画布立刻反映真实状态（check 内部吞错，不会阻塞启动失败）
await di.get("serverService").check(local.id);
// GitHub 更新轮询：只提示不自动部署
di.get("updatePoller").start();
// 容器状态轮询 → 事件总线 → SSE：SSH 频率与前端用户数无关
di.get("containerPoller").start();
