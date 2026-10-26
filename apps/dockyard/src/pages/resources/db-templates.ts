import { ServiceError } from "@elysiax/core";
import { randomBytes } from "node:crypto";
import { parse as parseDotenv } from "dotenv";

export type DbType = "postgres" | "mysql" | "redis" | "mongo";

const IMAGES: Record<DbType, string> = {
  postgres: "postgres:17",
  mysql: "mysql:8.4",
  redis: "redis:7",
  mongo: "mongo:8",
};

const PORTS: Record<DbType, number> = {
  postgres: 5432,
  mysql: 3306,
  redis: 6379,
  mongo: 27017,
};

// 各官方镜像的数据目录（挂错路径 = 数据没持久化）
const DATA_DIRS: Record<DbType, string> = {
  postgres: "/var/lib/postgresql/data",
  mysql: "/var/lib/mysql",
  redis: "/data",
  mongo: "/data/db",
};

export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

export { PORTS as DB_PORTS };

/** 容器命名规范：定死，部署前对账和 docker exec 都靠它 */
export function containerNameOf(targetId: number, name: string): string {
  return `dockyard-${targetId}-${name}`;
}

/** 共享资源容器命名规范：dockyard-res-<resourceId>-<name>（与 deploy target 的 dockyard-<id>- 前缀区分） */
export function sharedContainerNameOf(resourceId: number, name: string): string {
  return `dockyard-res-${resourceId}-${name}`;
}

/** 官方镜像模板：数据卷 + 自动生成的凭据（env 走 .env，compose 无 secret）
 *  所有权标签：dockyard.managed / target-id（或 shared-resource）—— 部署前对账靠它区分"我们的"和"别人的"容器 */
export function dbCompose(
  dbType: DbType,
  name: string,
  ownership?: { targetId: number; project: string } | { resourceId: number },
): { compose: string; env: string; port: number } {
  const image = IMAGES[dbType];
  const port = PORTS[dbType];
  const password = generatePassword();
  const volume = `${name}-data`;
  const labels = ownership
    ? "resourceId" in ownership
      ? `    labels:
      dockyard.managed: "true"
      dockyard.shared-resource: "${ownership.resourceId}"
`
      : `    labels:
      dockyard.managed: "true"
      dockyard.target-id: "${ownership.targetId}"
      dockyard.project: "${ownership.project}"
`
    : "";
  const containerName = ownership
    ? `    container_name: ${"resourceId" in ownership ? sharedContainerNameOf(ownership.resourceId, name) : containerNameOf(ownership.targetId, name)}\n`
    : "";

  const envByType: Record<DbType, { env: Record<string, string>; lines: string[] }> = {
    postgres: {
      env: { POSTGRES_PASSWORD: password },
      lines: [`POSTGRES_PASSWORD=${password}`],
    },
    mysql: {
      env: { MYSQL_ROOT_PASSWORD: password },
      lines: [`MYSQL_ROOT_PASSWORD=${password}`],
    },
    redis: { env: {}, lines: [] },
    mongo: {
      env: { MONGO_INITDB_ROOT_USERNAME: "root", MONGO_INITDB_ROOT_PASSWORD: password },
      lines: [`MONGO_INITDB_ROOT_USERNAME=root`, `MONGO_INITDB_ROOT_PASSWORD=${password}`],
    },
  };
  const { env, lines } = envByType[dbType];

  const envBlock = Object.keys(env).length
    ? `    env_file: .env\n`
    : "";
  const compose = `services:
  ${name}:
    image: ${image}
    restart: unless-stopped
${containerName}${labels}${envBlock}    ports:
      - "${port}:${port}"
    volumes:
      - ${volume}:${DATA_DIRS[dbType]}
volumes:
  ${volume}:
`;
  return { compose, env: lines.join("\n") + "\n", port };
}

// ── 逻辑库：在已有实例里 CREATE DATABASE + 专属账号 ──

/** redis 没有逻辑库/账号概念（ACL 二期），不支持共享 */
export const LOGICAL_DB_SUPPORT: Record<DbType, boolean> = {
  postgres: true,
  mysql: true,
  mongo: true,
  redis: false,
};

// SQL 标识符注入防护：逻辑库名只允许安全字符
const SAFE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
function assertSafeName(name: string) {
  if (!SAFE_NAME.test(name))
    throw new ServiceError(`逻辑库名只允许字母/数字/下划线且以字母开头: ${name}`);
}

/** 实例内执行的管理命令（在宿主容器里 docker exec）。
 *  create 是命令序列：postgres 的 CREATE DATABASE 不能和 CREATE USER 同处一个
 *  隐式事务（单个 -c 多语句会包事务），必须分多次 exec。 */
export function logicalDbCommands(
  dbType: DbType,
  name: string,
  password: string,
): { exists: string[]; create: string[][] } {
  assertSafeName(name);
  if (!LOGICAL_DB_SUPPORT[dbType]) throw new ServiceError(`${dbType} 不支持逻辑库`);
  switch (dbType) {
    case "postgres":
      return {
        exists: ["psql", "-U", "postgres", "-tAc", `SELECT 1 FROM pg_database WHERE datname='${name}'`],
        create: [
          // 上次在 CREATE DATABASE 失败时会留下孤儿 role；库不存在的前提下 DROP 是安全的
          ["psql", "-U", "postgres", "-c", `DROP USER IF EXISTS "${name}"; CREATE USER "${name}" PASSWORD '${password}'`],
          ["psql", "-U", "postgres", "-c", `CREATE DATABASE "${name}" OWNER "${name}"`],
        ],
      };
    case "mysql":
      return {
        exists: ["sh", "-c", `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${name}'"`],
        create: [["sh", "-c", `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "CREATE DATABASE \\\`${name}\\\`; CREATE USER '${name}'@'%' IDENTIFIED BY '${password}'; GRANT ALL ON \\\`${name}\\\`.* TO '${name}'@'%';"`]],
      };
    case "mongo":
      // mongo 没有 CREATE DATABASE，建用户即隐式建库
      return {
        exists: ["sh", "-c", `mongosh -u root -p "$MONGO_INITDB_ROOT_PASSWORD" --quiet --eval "db.getMongo().getDBNames().includes('${name}')"`],
        create: [["sh", "-c", `mongosh -u root -p "$MONGO_INITDB_ROOT_PASSWORD" --quiet --eval "db.getSiblingDB('${name}').createUser({user:'${name}',pwd:'${password}',roles:[{role:'readWrite',db:'${name}'}]})"`]],
      };
    default:
      throw new ServiceError(`${dbType} 不支持逻辑库`);
  }
}

/** 逻辑库连接串 */
/** 实例目标的根连接串：从创建时生成的 env 文本里取密码推导（env 缺密码的类型返回 null） */
export function instanceUrl(dbType: DbType, host: string, envText: string): string | null {
  const port = PORTS[dbType];
  const env = parseDotenv(envText);
  const pick = (key: string) => env[key];
  switch (dbType) {
    case "postgres": {
      const pw = pick("POSTGRES_PASSWORD");
      return pw ? `postgres://postgres:${pw}@${host}:${port}/postgres` : null;
    }
    case "mysql": {
      const pw = pick("MYSQL_ROOT_PASSWORD");
      return pw ? `mysql://root:${pw}@${host}:${port}` : null;
    }
    case "redis":
      return `redis://${host}:${port}`;
    case "mongo": {
      const pw = pick("MONGO_INITDB_ROOT_PASSWORD");
      return pw ? `mongodb://root:${pw}@${host}:${port}` : null;
    }
  }
}

/** 连接串建议注入的环境变量名（app 侧惯例） */
export function suggestedEnvKey(dbType: DbType): string {
  return dbType === "redis" ? "REDIS_URL" : "DATABASE_URL";
}

export function logicalDbUrl(dbType: DbType, host: string, name: string, password: string): string {
  const port = PORTS[dbType];
  switch (dbType) {
    case "postgres": return `postgres://${name}:${password}@${host}:${port}/${name}`;
    case "mysql": return `mysql://${name}:${password}@${host}:${port}/${name}`;
    case "mongo": return `mongodb://${name}:${password}@${host}:${port}/${name}`;
    default: throw new ServiceError(`${dbType} 不支持逻辑库`);
  }
}
