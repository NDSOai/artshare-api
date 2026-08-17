import { sql } from "../db.js";
import { decryptBody } from "./crypto-message.js";

export async function purgeUnreadableMessages() {
  const rows = await sql<{ id: string; body_enc: string }[]>`select id, body_enc from messages`;
  const bad = rows.filter((row) => !decryptBody(row.body_enc)).map((row) => row.id);
  if (bad.length === 0) {
    console.log(`[messages] purge skipped, ${rows.length} readable`);
    return;
  }
  await sql`delete from messages where id in ${sql(bad)}`;
  console.log(`[messages] purged ${bad.length} unreadable of ${rows.length}`);
}
