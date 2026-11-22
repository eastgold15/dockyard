import { describe, expect, test } from "bun:test";
import { IMAGE_VARS, providedVars, derivedVars } from "./db-vars";
import { dbCompose, instanceUrl, renderImageVars } from "./db-templates";

describe("IMAGE_VARS", () => {
  test("postgres 声明了镜像要的变量", () => {
    const keys = IMAGE_VARS.postgres.map((v) => v.key);
    expect(keys).toContain("POSTGRES_USER");
    expect(keys).toContain("POSTGRES_PASSWORD");
    expect(keys).toContain("POSTGRES_DB");
    expect(keys).toContain("PGDATA");
  });

  test("密码类标记为敏感", () => {
    const pw = IMAGE_VARS.postgres.find((v) => v.key === "POSTGRES_PASSWORD");
    expect(pw!.secret).toBe(true);
    expect(pw!.generate).toBe(true);
  });

  test("redis 无变量（镜像不需要）", () => {
    expect(IMAGE_VARS.redis).toEqual([]);
  });

  test("PGDATA 默认值 = 镜像默认（改了等于换数据目录，旧库读不到数据）", () => {
    const pgdata = IMAGE_VARS.postgres.find((v) => v.key === "PGDATA");
    expect(pgdata!.defaultValue).toBe("/var/lib/postgresql/data");
  });

  test("镜像变量的默认值不会改变旧模板行为（PGDATA 之外的键都是镜像认的）", () => {
    // 旧模板只写 POSTGRES_PASSWORD；新表多出来的键默认值必须等于镜像默认
    const pg = IMAGE_VARS.postgres;
    expect(pg.find((v) => v.key === "POSTGRES_USER")!.defaultValue).toBe(
      "postgres",
    );
    expect(pg.find((v) => v.key === "POSTGRES_DB")!.defaultValue).toBe(
      "postgres",
    );
  });
});

describe("renderImageVars", () => {
  test("渲染出 .env 行，含默认值与生成的密码", () => {
    const { env, lines } = renderImageVars("postgres");
    expect(env.POSTGRES_USER).toBe("postgres");
    expect(env.POSTGRES_DB).toBe("postgres");
    expect(env.POSTGRES_PASSWORD!.length).toBeGreaterThan(10);
    expect(lines).toContain("POSTGRES_USER=postgres");
  });

  test("redis 渲染出空表", () => {
    const { env, lines } = renderImageVars("redis");
    expect(env).toEqual({});
    expect(lines).toEqual([]);
  });
});

describe("dbCompose", () => {
  test("compose 用 env_file 装载变量表", () => {
    const rendered = dbCompose("postgres", "pg-main", { targetId: 1 });
    expect(rendered.compose).toContain("env_file: .env");
    expect(rendered.env).toContain("POSTGRES_PASSWORD=");
  });
});

describe("instanceUrl", () => {
  test("按变量表里的用户名与库名拼连接串", () => {
    const url = instanceUrl(
      "postgres",
      "10.0.0.5",
      "POSTGRES_USER=app\nPOSTGRES_PASSWORD=pw\nPOSTGRES_DB=tradeflow\n",
    );
    expect(url).toBe("postgres://app:pw@10.0.0.5:5432/tradeflow");
  });

  test("缺密码返回 null（连接串拼不出来）", () => {
    expect(instanceUrl("postgres", "h", "POSTGRES_USER=app\n")).toBe(null);
  });

  test("密码里的特殊字符被转义", () => {
    const url = instanceUrl(
      "postgres",
      "h",
      "POSTGRES_USER=app\nPOSTGRES_PASSWORD=p@ss/w+d\nPOSTGRES_DB=db\n",
    );
    expect(url).toContain("p%40ss%2Fw%2Bd");
  });
});

describe("providedVars", () => {
  test("列出镜像变量 + 派生连接串", () => {
    const vars = providedVars({
      dbType: "postgres",
      envText: "POSTGRES_USER=app\nPOSTGRES_PASSWORD=pw\nPOSTGRES_DB=tradeflow\n",
      host: "10.0.0.5",
      port: 5432,
    });
    const keys = vars.map((v) => v.key);
    expect(keys).toContain("POSTGRES_PASSWORD");
    expect(keys).toContain("DATABASE_URL");
    const url = vars.find((v) => v.key === "DATABASE_URL")!;
    expect(url.kind).toBe("derived");
    expect(url.value).toContain("app:pw@10.0.0.5:5432/tradeflow");
    expect(url.secret).toBe(true);
  });

  test("自定义的键也列出来", () => {
    const vars = providedVars({
      dbType: "postgres",
      envText: "POSTGRES_PASSWORD=pw\nMY_CUSTOM=1\n",
    });
    const custom = vars.find((v) => v.key === "MY_CUSTOM");
    expect(custom).toBeDefined();
    expect(custom!.kind).toBe("image");
  });

  test("没填值的变量也在表里（值空）", () => {
    const vars = providedVars({ dbType: "postgres", envText: "" });
    const pw = vars.find((v) => v.key === "POSTGRES_PASSWORD");
    expect(pw).toBeDefined();
    expect(pw!.value).toBe("");
  });
});

describe("derivedVars", () => {
  test("给了 url 就直接用（共享资源已回填连接串）", () => {
    const vars = derivedVars({
      dbType: "postgres",
      host: "h",
      port: 5432,
      envText: "",
      url: "postgres://u:p@h:5432/db",
    });
    expect(vars[0]!.value).toBe("postgres://u:p@h:5432/db");
  });
});
