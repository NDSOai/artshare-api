import { sql } from "../db.js";
import { decryptBody, encryptBody, needsRekey } from "./crypto-message.js";

/** Rewrite rows encrypted with an older secret onto MESSAGE_SECRET. Never delete or blank a body. */
export async function rekeyMessages() {
  const rows = await sql<{ id: string; body_enc: string }[]>`select id, body_enc from messages`;
  let rekeyed = 0;
  let unreadable = 0;
  for (const row of rows) {
    const text = decryptBody(row.body_enc);
    if (!text) {
      unreadable += 1;
      continue;
    }
    if (!needsRekey(row.body_enc, text)) continue;
    const next = encryptBody(text);
    if (decryptBody(next) !== text) continue;
    await sql`update messages set body_enc = ${next} where id = ${row.id}`;
    rekeyed += 1;
  }
  console.log(`[messages] ${rows.length} stored, ${rekeyed} rekeyed, ${unreadable} still unreadable`);
}
