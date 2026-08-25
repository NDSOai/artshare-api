import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { sql } from "../db.js";
import { env } from "../env.js";

let primary: Buffer | null = null;
const extras: Buffer[] = [];

function asKey(secret: string) {
  return createHash("sha256").update(secret).digest();
}

function fingerprint(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
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

function asPayload(payload: unknown) {
  if (typeof payload === "string") return payload.trim();
  if (Buffer.isBuffer(payload)) return payload.toString("utf8").trim();
  return "";
}

/**
 * New writes use MESSAGE_SECRET from the environment.
 * A leftover Postgres secret is read-only, so old threads still open if env changed.
 * We never write that leftover secret, and we never blank a body we could not decrypt.
 */
export async function initMessageCrypto() {
  extras.length = 0;
  const current = env.messageSecret.trim();
  if (!current) throw new Error("Missing MESSAGE_SECRET");
  primary = asKey(current);

  const [legacy] = await sql<{ value: string }[]>`
    select value from app_kv where key = 'message_secret' limit 1
  `;
  const [fpRow] = await sql<{ value: string }[]>`
    select value from app_kv where key = 'message_secret_fp' limit 1
  `;

  for (const secret of uniqueSecrets([
    legacy?.value ?? "",
    ...(process.env.MESSAGE_SECRET_PREV || "").split(","),
  ])) {
    if (secret === current) continue;
    extras.push(asKey(secret));
  }

  const fp = fingerprint(current);
  if (fpRow?.value && fpRow.value !== fp) {
    console.warn(
      `[messages] MESSAGE_SECRET changed; keeping ${extras.length} older key${extras.length === 1 ? "" : "s"} for reads`,
    );
  }
  await sql`
    insert into app_kv (key, value) values ('message_secret_fp', ${fp})
    on conflict (key) do update set value = excluded.value
  `;

  console.log(`[messages] crypto from env (${1 + extras.length} key${1 + extras.length === 1 ? "" : "s"})`);
}

function requirePrimary() {
  if (!primary) throw new Error("Message crypto is not ready.");
  return primary;
}

function openPayload(payload: string, key: Buffer) {
  const buf = Buffer.from(payload, "base64");
  if (buf.length < 29) throw new Error("short");
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
    return null;
  }
}

export function encryptBody(text: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", requirePrimary(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptBody(payload: unknown) {
  const raw = asPayload(payload);
  if (!raw) return "";
  const keys = primary ? [primary, ...extras] : extras;
  for (const key of keys) {
    const text = decryptWith(raw, key);
    if (text !== null) return text;
  }
  return "";
}

export function needsRekey(payload: unknown, text: string) {
  if (!text || !primary) return false;
  const raw = asPayload(payload);
  if (!raw) return false;
  return decryptWith(raw, primary) !== text;
}
