import { status, t } from "elysia";
import { createHmac, timingSafeEqual } from "node:crypto";
import { defineRoutes, type ServiceMap } from "../../../.elysiax";
import type { AppStatus } from "./github.service";

/** DI 容器视图：键与返回类型全部来自 codegen 的 ServiceMap，不重抄 */
type Di = { get<K extends keyof ServiceMap>(k: K): ServiceMap[K] };

/** github 原子的 JSON API：GitHub App 授权状态/配置 + push webhook */
export default defineRoutes()
  /** 当前凭据状态（App 已配置？账号是谁？webhook secret 有没有？） */
  .get("/app", async ({ di }): Promise<AppStatus> => di.get("githubService").appStatus())
  /**
   * 保存 App 凭据（App ID / Installation ID / 私钥 PEM / 可选 webhook secret）。
   * 服务端先换 installation token 验证，通过才落库——存下不可用的私钥等于没配。
   */
  .post(
    "/app",
    {
      body: t.Object({
        appId: t.String(),
        installationId: t.String(),
        privateKeyPem: t.String(),
        webhookSecret: t.Optional(t.String()),
      }),
    },
    async ({ di, body }): Promise<AppStatus> =>
      di.get("githubService").saveApp({
        appId: body.appId,
        installationId: body.installationId,
        privateKeyPem: body.privateKeyPem,
        webhookSecret: body.webhookSecret ?? null,
      }),
  )
  /** 解除授权（删凭据，回落 gh CLI） */
  .delete("/app", async ({ di }): Promise<{ ok: boolean }> => {
    await di.get("githubService").removeApp();
    return { ok: true };
  })
  /**
   * push webhook：GitHub 推到主分支后立刻触发一次更新检查（不等 60s 轮询）。
   * 签名校验：X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(secret, body)。
   * 只处理 push 事件；其它事件直接 202 忽略。
   */
  .post(
    "/webhook",
    { parse: "none" },
    async ({ di, request }): Promise<unknown> => {
      const body = await request.text();
      const install = await di.get("githubService").appInstall();
      if (!install?.webhookSecret)
        return status(400, { error: "未配置 webhook secret" });
      const sig = request.headers.get("x-hub-signature-256") ?? "";
      const expected = `sha256=${createHmac("sha256", install.webhookSecret).update(body).digest("hex")}`;
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b))
        return status(401, { error: "签名校验失败" });
      const event = request.headers.get("x-github-event") ?? "";
      if (event !== "push") return { ok: true, ignored: event };
      let payload: {
        ref?: string;
        repository?: { full_name?: string };
      };
      try {
        payload = JSON.parse(body);
      } catch {
        return status(400, { error: "载荷不是合法 JSON" });
      }
      const fullName = payload.repository?.full_name;
      if (!fullName) return { ok: true, ignored: "no-repository" };
      // 只处理分支推送（tag 推送不触发构建）
      if (payload.ref && !payload.ref.startsWith("refs/heads/"))
        return { ok: true, ignored: "not-a-branch" };
      await di.get("updatePoller").checkRepo(fullName);
      return { ok: true, repo: fullName };
    },
  );
