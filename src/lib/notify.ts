import { sql } from "../db.js";
import { newId } from "./tokens.js";

export async function notify(input: {
  userId: string;
  fromId?: string | null;
  workId?: string | null;
  type: "like" | "comment" | "follow";
  text: string;
}) {
  if (input.fromId && input.fromId === input.userId) return;
  await sql`
    insert into notifications (id, user_id, type, from_id, work_id, text)
    values (
      ${newId("n")},
      ${input.userId},
      ${input.type},
      ${input.fromId ?? null},
      ${input.workId ?? null},
      ${input.text}
    )
  `;
}
