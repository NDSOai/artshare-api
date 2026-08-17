import { sql } from "../db.js";
import { decryptBody } from "./crypto-message.js";

/** Log decrypt failures. Never delete — a secret mismatch used to wipe chat history on deploy. */
export async function purgeUnreadableMessages() {
  const rows = await sql<{ id: string; body_enc: string }[]>`select id, body_enc from messages`;
  const bad = rows.filter((row) => !decryptBody(row.body_enc)).map((row) => row.id);
  if (bad.length === 0) {
    console.log(`[messages] ${rows.length} readable`);
    return;
  }
  console.warn(`[messages] ${bad.length} of ${rows.length} could not decrypt; leaving them in place`);
}
