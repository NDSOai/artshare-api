import { Hono } from "hono";
import { sql, type UserRow } from "../db.js";
import { decryptBody, encryptBody } from "../lib/crypto-message.js";
import { requireAuth, type Authed } from "../lib/auth-mw.js";
import { notify } from "../lib/notify.js";
import { newId } from "../lib/tokens.js";
import { areMutual } from "./follows.js";

export const messageRoutes = new Hono<{ Variables: Authed }>();

type MessageRow = {
  id: string;
  sender_id: string;
  recipient_id: string;
  body_enc: string;
  created_at: Date;
  sender_handle: string;
};

function open(row: MessageRow) {
  return {
    id: row.id,
    from: row.sender_handle,
    text: decryptBody(row.body_enc),
    at: row.created_at.getTime(),
  };
}

async function findUser(handle: string) {
  const [user] = await sql<UserRow[]>`select * from users where lower(handle) = ${handle.toLowerCase()} limit 1`;
  return user ?? null;
}

messageRoutes.use("*", requireAuth);

messageRoutes.get("/", async (c) => {
  const me = c.get("user");
  const rows = await sql<(MessageRow & { other_handle: string; other_name: string })[]>`
    select distinct on (least(m.sender_id, m.recipient_id), greatest(m.sender_id, m.recipient_id))
      m.*,
      s.handle as sender_handle,
      case when m.sender_id = ${me.id} then r.handle else s.handle end as other_handle,
      case when m.sender_id = ${me.id} then r.name else s.name end as other_name
    from messages m
    join users s on s.id = m.sender_id
    join users r on r.id = m.recipient_id
    where m.sender_id = ${me.id} or m.recipient_id = ${me.id}
    order by least(m.sender_id, m.recipient_id), greatest(m.sender_id, m.recipient_id), m.created_at desc
  `;
  return c.json({
    threads: rows.map((row) => ({
      id: row.other_handle,
      handle: row.other_handle,
      name: row.other_name,
      last: open(row),
    })),
  });
});

messageRoutes.get("/:handle", async (c) => {
  const me = c.get("user");
  const them = await findUser(c.req.param("handle"));
  if (!them) return c.json({ error: "Artist not found." }, 404);
  if (!(await areMutual(me.id, them.id))) {
    return c.json({ error: "You both need to follow each other to chat." }, 403);
  }
  const rows = await sql<MessageRow[]>`
    select m.*, s.handle as sender_handle
    from messages m
    join users s on s.id = m.sender_id
    where (m.sender_id = ${me.id} and m.recipient_id = ${them.id})
       or (m.sender_id = ${them.id} and m.recipient_id = ${me.id})
    order by m.created_at asc
  `;
  return c.json({
    handle: them.handle,
    messages: rows.map(open),
  });
});

messageRoutes.post("/:handle", async (c) => {
  const me = c.get("user");
  const them = await findUser(c.req.param("handle"));
  if (!them) return c.json({ error: "Artist not found." }, 404);
  if (them.id === me.id) return c.json({ error: "You cannot message yourself." }, 400);
  if (!(await areMutual(me.id, them.id))) {
    return c.json({ error: "You both need to follow each other to chat." }, 403);
  }
  const body = await c.req.json<{ text?: string }>();
  const text = (body.text || "").trim();
  if (!text) return c.json({ error: "Write a message first." }, 400);

  const [row] = await sql<MessageRow[]>`
    insert into messages (id, sender_id, recipient_id, body_enc)
    values (${newId("msg")}, ${me.id}, ${them.id}, ${encryptBody(text)})
    returning *, ${me.handle} as sender_handle
  `;
  await notify({
    userId: them.id,
    fromId: me.id,
    type: "message",
    text: "sent you a message",
  });
  return c.json({ message: open(row) }, 201);
});
