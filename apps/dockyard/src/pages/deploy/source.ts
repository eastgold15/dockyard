/**
 * 取码通道：远端直连 GitHub / 控制面代理。
 *
 * 为什么需要两条通道：国内服务器连不上（或极慢）GitHub。此时远端 git clone/fetch
 * 注定失败，跑三次也只是白等。控制面（跑 dockyard 的这台机器）线路正常，
 * 由它下载源码再经 SFTP 推给远端，远端全程不碰 GitHub。
 */
import { ServiceError } from "@elysiax/core";
import { openServerSftp } from "@/pages/servers/servers.socket";
import type { ServerTransport } from "@/pages/servers/servers.socket";
import type { Harness } from "./pipeline";

/**
 * 探远端到 GitHub 的连通性。
 *
 * 5s 超时：探活不需要真下载，HEAD 请求能建立 TLS 就算通。
 * 返回 false 时远端不要指望自己能 clone。
 */
export async function probeGithub(client: ServerTransport): Promise<boolean> {
  const res = await client.exec(
    `curl -sS -o /dev/null -w '%{http_code}' --max-time 5 https://github.com 2>/dev/null || echo 000`,
  );
  return /^[23]/.test(res.stdout.trim());
}

/** 工作目录名：只留安全字符，防路径穿越（见 forms.ts 的用法） */
export function safeDirName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
}

/**
 * 控制面代理取码：控制面从 GitHub 下载 tarball → 推到远端 → 远端解包。
 *
 * 用 GitHub API 的 tarball 端点（带 token，私有库也能拉；codeload 直链不认 token）。
 * 解包后远端目录里没有 .git——compose 构建不依赖 git 历史，只有「取码判定」需要
 * 提交号，所以额外写 .dockyard-sha 供下一轮比对。
 */
export async function fetchViaControlPlane(
  h: Harness,
  client: ServerTransport,
  opts: {
    ownerRepo: string;
    branch: string;
    srcDir: string;
    log: (chunk: string) => Promise<void> | void;
    /** 已知 sha（控制面查到的上游提交） */
    sha?: string;
  },
): Promise<void> {
  const { ownerRepo, branch, srcDir, log } = opts;
  const tarball = await h.github.tarball(ownerRepo, branch);
  await log(
    `控制面已下载 ${ownerRepo}@${branch}（${(tarball.byteLength / 1024 / 1024).toFixed(1)} MB），推送远端…`,
  );

  // 解包到独立的新目录，成功后再换过去：失败时旧工作目录还在，不至于半个残缺目录
  const staging = `${srcDir}.incoming`;
  const tmpTar = `${srcDir}.tar.gz`;
  const sftp = await openServerSftp(client);
  try {
    await sftp.write(tmpTar, tarball);
  } finally {
    await sftp.close();
  }

  // GitHub 的 tarball 顶层是 <owner>-<repo>-<sha>/ 一层，解包时剥掉。
  // 清目录用 find -delete 而不是 rm -rf：路径必须落在 ~/dockyard/src/ 下，
  // 否则直接中止——这个目录是要被整体替换的工作目录，误删代价高。
  const unpack = await client.exec(
    `set -e; ` +
      `case "${srcDir}" in */dockyard/src/*) ;; *) echo "拒绝操作非工作目录: ${srcDir}" >&2; exit 9;; esac; ` +
      `find "${staging}" -mindepth 1 -delete 2>/dev/null || true; ` +
      `mkdir -p "${staging}"; ` +
      `tar -xzf "${tmpTar}" -C "${staging}" --strip-components=1; ` +
      `find "${srcDir}" -mindepth 1 -delete 2>/dev/null || true; ` +
      `cp -a "${staging}/." "${srcDir}/"; ` +
      `find "${staging}" -mindepth 1 -delete 2>/dev/null || true; ` +
      `rm -f "${tmpTar}"`,
  );
  if (unpack.code !== 0)
    throw new ServiceError(
      `远端解包失败（exit ${unpack.code}）：${unpack.stderr || unpack.stdout}`,
    );

  // 没有 .git 就没有 rev-parse；写标记文件让下一轮能比对提交号
  if (opts.sha) {
    const stamp = await client.exec(
      `printf '%s' "${opts.sha}" > "${srcDir}/.dockyard-sha"`,
    );
    if (stamp.code !== 0)
      throw new ServiceError(
        `远端写入提交标记失败（exit ${stamp.code}）：${stamp.stderr || stamp.stdout}`,
      );
  }
  await log(`远端源码就绪：${srcDir}`);
}
