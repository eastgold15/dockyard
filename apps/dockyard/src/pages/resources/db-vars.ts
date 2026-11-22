/**
 * 镜像变量表：官方数据库镜像「要什么变量」的声明。
 *
 * Railway 的做法：部署一个服务时，表单直接列出该镜像的变量清单让你填值；
 * 别的服务再从它那里挑几个注入。dockyard 对齐这个模型——
 * 部署 postgres 时看到 POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB / PGDATA，
 * 填完的值就是「这个数据库对外提供的变量」，应用侧勾选注入。
 *
 * 为什么要显式声明而不是读容器：容器起来了才知道密码读什么，等于事后；
 * 变量表是部署前就确定的，用户填完即可勾选。
 */
import { parse as parseDotenv } from "dotenv";
import { dbConnectionUrl, suggestedEnvKey, type DbType } from "./db-templates";

/** 镜像变量的一条声明 */
export interface ImageVar {
  key: string;
  /** 表单上的中文名 */
  label: string;
  /** 默认值（用户可改） */
  defaultValue?: string;
  /** 每次创建生成一个新值（密码类） */
  generate?: boolean;
  /** 是否敏感（UI 打码） */
  secret?: boolean;
  /** 说明 */
  description?: string;
  /** 是否必填（无默认值且不自动生成） */
  required?: boolean;
}

/** 各镜像的变量声明表 */
export const IMAGE_VARS: Record<DbType, ImageVar[]> = {
  postgres: [
    {
      key: "POSTGRES_USER",
      label: "数据库用户",
      defaultValue: "postgres",
      description: "初始超级用户",
    },
    {
      key: "POSTGRES_PASSWORD",
      label: "数据库密码",
      generate: true,
      secret: true,
      description: "初始超级用户密码",
    },
    {
      key: "POSTGRES_DB",
      label: "初始数据库",
      defaultValue: "postgres",
      description: "镜像初始化时创建的库",
    },
    {
      key: "PGDATA",
      label: "数据目录",
      // 必须与镜像默认一致：改了 PGDATA = 换了数据目录 = 旧库读不到数据。
      // 旧模板没设这个变量（PG 用镜像默认），所以默认值必须等于镜像默认。
      defaultValue: "/var/lib/postgresql/data",
      description: "数据目录（改它等于换库，旧数据会看不见）",
    },
  ],
  mysql: [
    {
      key: "MYSQL_ROOT_PASSWORD",
      label: "root 密码",
      generate: true,
      secret: true,
      description: "初始 root 密码",
    },
    {
      key: "MYSQL_DATABASE",
      label: "初始数据库",
      defaultValue: "tradeflow",
      description: "镜像初始化时创建的库",
    },
    {
      key: "MYSQL_USER",
      label: "初始用户",
      defaultValue: "tradeflow",
      description: "除 root 外的初始账号",
    },
    {
      key: "MYSQL_PASSWORD",
      label: "初始用户密码",
      generate: true,
      secret: true,
      description: "初始账号的密码",
    },
  ],
  redis: [],
  mongo: [
    {
      key: "MONGO_INITDB_ROOT_USERNAME",
      label: "root 用户",
      defaultValue: "root",
    },
    {
      key: "MONGO_INITDB_ROOT_PASSWORD",
      label: "root 密码",
      generate: true,
      secret: true,
    },
    {
      key: "MONGO_INITDB_DATABASE",
      label: "初始数据库",
      defaultValue: "tradeflow",
    },
  ],
};

/** 变量表里哪些键必填（无默认值也不自动生成） */
export function requiredVarsOf(dbType: DbType): ImageVar[] {
  return IMAGE_VARS[dbType].filter((v) => v.required);
}

/** 变量表里哪些键敏感 */
export function secretKeysOf(dbType: DbType): string[] {
  return IMAGE_VARS[dbType]
    .filter((v) => v.secret)
    .map((v) => v.key);
}

/**
 * 一个来源能提供的变量（勾选列表的数据源）。
 *
 * 两类来源，语义不同：
 * - 镜像变量：用户在部署数据库时填的值（POSTGRES_PASSWORD 等），容器真的吃到
 * - 派生连接串：dockyard 按镜像变量算出来的 DATABASE_URL，容器自己不吃，给 app 用
 */
export interface ProvidedVar {
  key: string;
  value: string;
  /** 是否敏感（UI 打码） */
  secret: boolean;
  /** 来源类型：image = 镜像变量；derived = 派生连接串 */
  kind: "image" | "derived";
  /** 中文说明 */
  description?: string;
}

/** 派生连接串：按镜像变量表 + 连接信息算出 DATABASE_URL 之类的值 */
export function derivedVars(input: {
  dbType: DbType;
  host: string;
  port: number;
  envText: string;
  /** 已知的连接串（共享资源部署成功后回填的；给了就用它，不重算） */
  url?: string | null;
  /** 连接串里的库名（逻辑库用；实例取镜像变量的初始库） */
  database?: string;
  user?: string;
  password?: string;
}): ProvidedVar[] {
  const env = parseDotenv(input.envText);
  const urlKey = suggestedEnvKey(input.dbType);
  const user =
    input.user ??
    env.POSTGRES_USER ??
    env.MYSQL_USER ??
    env.MONGO_INITDB_ROOT_USERNAME ??
    undefined;
  const password =
    input.password ??
    env.POSTGRES_PASSWORD ??
    env.MYSQL_ROOT_PASSWORD ??
    env.MONGO_INITDB_ROOT_PASSWORD ??
    undefined;
  const database =
    input.database ??
    env.POSTGRES_DB ??
    env.MYSQL_DATABASE ??
    env.MONGO_INITDB_DATABASE ??
    undefined;
  const url =
    input.url ??
    dbConnectionUrl(input.dbType, {
      host: input.host,
      port: input.port,
      ...(user ? { user } : {}),
      ...(password ? { password } : {}),
      ...(database ? { database } : {}),
    });
  if (!url) return [];
  return [
    {
      key: urlKey,
      value: url,
      secret: true,
      kind: "derived",
      description: "连接串（dockyard 按上面填的变量算出）",
    },
  ];
}

/**
 * 镜像变量 + 派生连接串 → 完整清单。
 *
 * 变量表声明的键一定在清单里（哪怕值为空——那说明用户没填，勾了也没用）；
 * env 里出现但变量表没声明的键也带上（用户自己加的）。
 */
export function providedVars(input: {
  dbType: DbType;
  envText: string;
  host?: string;
  port?: number;
  /** 已知的连接串（共享资源部署成功后回填的；给了就用它，不重算） */
  url?: string | null;
  /** 逻辑库用：指定库名/用户/密码（实例则从 envText 取） */
  database?: string;
  user?: string;
  password?: string;
}): ProvidedVar[] {
  const env = parseDotenv(input.envText);
  const declared = new Map(IMAGE_VARS[input.dbType].map((v) => [v.key, v]));
  const out: ProvidedVar[] = [];
  for (const v of IMAGE_VARS[input.dbType]) {
    const value = env[v.key] ?? "";
    out.push({
      key: v.key,
      value,
      secret: Boolean(v.secret),
      kind: "image",
      description: v.description ?? v.label,
    });
  }
  // 用户自己加的键（不在声明表里）也提供出去
  for (const [key, value] of Object.entries(env)) {
    if (declared.has(key)) continue;
    out.push({
      key,
      value,
      secret: /PASS|PWD|SECRET|TOKEN|CREDENTIAL/i.test(key),
      kind: "image",
      description: "自定义变量",
    });
  }
  if (input.host && input.port) {
    out.push(
      ...derivedVars({
        dbType: input.dbType,
        host: input.host,
        port: input.port,
        envText: input.envText,
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.database ? { database: input.database } : {}),
        ...(input.user ? { user: input.user } : {}),
        ...(input.password ? { password: input.password } : {}),
      }),
    );
  }
  return out;
}
