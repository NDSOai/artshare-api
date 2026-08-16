import { Hono } from "hono";
import { sql } from "../db.js";
import { requireAuth, type Authed } from "../lib/auth-mw.js";

export const notificationRoutes = new Hono<{ Variables: Authed }>();

notificationRoutes.use("*", requireAuth);

notificationRoutes.get("/", async (c) => {
  const me = c.get("user");
  const rows = await sql<
    {
      id: string;
      type: string;
      text: string;
      read: boolean;
      created_at: Date;
      from_name: string | null;
      from_handle: string | null;
      work_id: string | null;
    }[]
  >`
    select n.id, n.type, n.text, n.read, n.created_at, n.work_id,
           u.name as from_name, u.handle as from_handle
    from notifications n
    left join users u on u.id = n.from_id
    where n.user_id = ${me.id}
    order by n.created_at desc
    limit 50
  `;
  return c.json({
    unread: rows.filter((row) => !row.read).length,
    notifications: rows.map((row) => ({
      id: row.id,
      type: row.type,
      from: row.from_name ?? "Someone",
      fromHandle: row.from_handle ?? "",
      text: row.text,
      workId: row.work_id,
      time: row.created_at.toISOString(),
      read: row.read,
    })),
  });
});

notificationRoutes.post("/read", async (c) => {
  const me = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as {
    type?: unknown;
    fromHandle?: unknown;
  };
  const type = typeof body.type === "string" && body.type.trim() ? body.type.trim() : null;
  const fromHandle =
    typeof body.fromHandle === "string" && body.fromHandle.trim()
      ? body.fromHandle.trim().toLowerCase()
      : null;

  if (type && fromHandle) {
    await sql`
      update notifications n
      set read = true
      from users u
      where n.user_id = ${me.id}
        and n.read = false
        and n.type = ${type}
        and n.from_id = u.id
        and lower(u.handle) = ${fromHandle}
    `;
  } else if (type) {
    await sql`
      update notifications
      set read = true
      where user_id = ${me.id} and read = false and type = ${type}
    `;
  } else {
    await sql`update notifications set read = true where user_id = ${me.id} and read = false`;
  }
  return c.json({ ok: true });
});
