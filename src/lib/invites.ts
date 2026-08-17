import { randomBytes } from "node:crypto";
import { sql, type UserRow } from "../db.js";
import { sendInviteCodesEmail } from "./email.js";

export const INVITE_PACK = 7;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function normalizeInviteCode(raw: string) {
  return raw.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

export function displayInviteCode(code: string) {
  const clean = normalizeInviteCode(code);
  if (clean.length === 8) return `${clean.slice(0, 4)}-${clean.slice(4)}`;
  return clean;
}

function generateInviteCode() {
  const bytes = randomBytes(8);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

export async function unusedInviteCodes(userId: string) {
  const rows = await sql<{ code: string }[]>`
    select code from invite_codes
    where issuer_id = ${userId} and redeemed_at is null
    order by created_at asc
  `;
  return rows.map((row) => row.code);
}

export async function peekOpenInvite(code: string) {
  const normalized = normalizeInviteCode(code);
  if (normalized.length < 6) return null;
  const [row] = await sql<{ code: string }[]>`
    select code from invite_codes
    where code = ${normalized} and redeemed_at is null
    limit 1
  `;
  return row?.code ?? null;
}

export async function redeemInvite(code: string, userId: string) {
  const normalized = normalizeInviteCode(code);
  const [row] = await sql<{ code: string }[]>`
    update invite_codes
    set redeemed_by = ${userId}, redeemed_at = now()
    where code = ${normalized} and redeemed_at is null
    returning code
  `;
  return Boolean(row);
}

async function insertCode(userId: string) {
  for (let i = 0; i < 8; i += 1) {
    const code = generateInviteCode();
    try {
      await sql`
        insert into invite_codes (code, issuer_id)
        values (${code}, ${userId})
      `;
      return code;
    } catch {
      /* unique collision, try again */
    }
  }
  throw new Error("Could not mint an invite code.");
}

export async function ensureInvitePack(userId: string) {
  const existing = await unusedInviteCodes(userId);
  if (existing.length > 0) return existing;
  const [issued] = await sql<{ n: number }[]>`
    select count(*)::int as n from invite_codes where issuer_id = ${userId}
  `;
  if ((issued?.n ?? 0) > 0) return unusedInviteCodes(userId);
  const codes: string[] = [];
  for (let i = 0; i < INVITE_PACK; i += 1) {
    codes.push(await insertCode(userId));
  }
  return codes;
}

export async function grantAndEmailInvites(user: Pick<UserRow, "id" | "email" | "name">) {
  const codes = await ensureInvitePack(user.id);
  if (codes.length === 0) {
    await sql`update users set invites_emailed_at = now() where id = ${user.id}`;
    return;
  }
  await sendInviteCodesEmail(user.email, user.name, codes.map(displayInviteCode));
  await sql`update users set invites_emailed_at = now() where id = ${user.id}`;
}

export async function backfillInvitePacks() {
  const users = await sql<UserRow[]>`
    select * from users
    where email_verified_at is not null
      and invites_emailed_at is null
    order by created_at asc
  `;
  for (const user of users) {
    try {
      await grantAndEmailInvites(user);
      console.log(`[invites] sent pack to ${user.email}`);
    } catch (err) {
      console.error(`[invites] could not email ${user.email}`, err);
    }
  }
}
