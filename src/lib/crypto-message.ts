import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../env.js";

function key() {
  return createHash("sha256").update(env.messageSecret).digest();
}

export function encryptBody(text: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function looksPlain(value: string) {
  if (!value) return false;
  if (value.includes(" ")) return true;
  return /^[\x09\x0a\x0d\x20-\x7e\u00a0-\u024f]+$/.test(value) && value.length < 1000;
}

export function decryptBody(payload: string) {
  if (!payload) return "";
  try {
    const buf = Buffer.from(payload, "base64");
    if (buf.length < 29) return looksPlain(payload) ? payload : "";
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch (err) {
    console.error("[message.decrypt]", err);
    return looksPlain(payload) ? payload : "";
  }
}
