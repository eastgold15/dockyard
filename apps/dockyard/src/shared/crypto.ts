import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { appPaths, ensureDirs } from "./paths";

// enc1: AES-256-GCM，密钥放数据目录（0600）。与 openship 的 enc1: 前缀约定一致。
function loadKey(): Buffer {
  ensureDirs();
  if (existsSync(appPaths.secretFile)) {
    return Buffer.from(readFileSync(appPaths.secretFile, "utf8").trim(), "hex");
  }
  const key = randomBytes(32);
  writeFileSync(appPaths.secretFile, key.toString("hex"), { mode: 0o600 });
  chmodSync(appPaths.secretFile, 0o600);
  return key;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `enc1:${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${enc.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith("enc1:")) return stored; // 兼容未加密历史值
  const [iv, tag, data] = stored.slice(5).split(".");
  const decipher = createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(iv!, "base64"));
  decipher.setAuthTag(Buffer.from(tag!, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data!, "base64")), decipher.final()]).toString("utf8");
}
