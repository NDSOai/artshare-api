import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { sql } from "../db.js";
import { env } from "../env.js";

let primary: Buffer | null = null;
const extras: Buffer[] = [];

function asKey(secret: string) {
  return createHash("sha256").update(secret).digest();
}

function uniqueSecrets(values: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const secret = value.trim();
    if (!secret || seen.has(secret)) continue;
    seen.add(secret);
    out.push(secret);
  }
  return out;
}

export async function initMessageCrypto() {
  extras.length = 0;
  primary = asKey(env.messageSecret);
  const [row] = await sql<{ value: string }[]>`
    select value from app_kv where key = 'message_secret' limit 1
  `;
  for (const secret of uniqueSecrets([
    row?.value ?? "",
    ...(process.env.MESSAGE_SECRET_PREV || "").split(","),
  ])) {
    if (secret === env.messageSecret) continue;
    extras.push(asKey(secret));
  }
  console.log(`[messages] crypto from env (${1 + extras.length} key${1 + extras.length === 1 ? "" : "s"})`);
}

function requirePrimary() {
  if (!primary) throw new Error("Message crypto is not ready.");
  return primary;
}

function openPayload(payload: string, key: Buffer) {
  const buf = Buffer.from(payload || "", "base64");
  if (buf.length < 29) return "";
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function decryptWith(payload: string, key: Buffer) {
  try {
    return openPayload(payload, key);
  } catch {
    return "";
  }
}

export function encryptBody(text: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", requirePrimary(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptBody(payload: string) {
  if (!payload) return "";
  const keys = primary ? [primary, ...extras] : extras;
  for (const key of keys) {
    const text = decryptWith(payload, key);
    if (text) return text;
  }
  return "";
}

export function needsRekey(payload: string, text: string) {
  if (!text || !primary) return false;
  return decryptWith(payload, primary) !== text;
}
