import { Hono } from "hono";
import { sql } from "../db.js";
import { requireAuth, type Authed } from "../lib/auth-mw.js";
import { newId } from "../lib/tokens.js";

export const commentRoutes = new Hono<{ Variables: Authed }>();

commentRoutes.get("/:workId/comments", async (c) => {
  const rows = await sql<
    { id: string; text: string; pin_x: number | null; pin_y: number | null; created_at: Date; author: string }[]
  >`
    select c.id, c.text, c.pin_x, c.pin_y, c.created_at, u.name as author
    from comments c
    join users u on u.id = c.author_id
    where c.work_id = ${c.req.param("workId")}
    order by c.created_at asc
  `;
  return c.json({
    comments: rows.map((row) => ({
      id: row.id,
      author: row.author,
      text: row.text,
      pinnedTo: row.pin_x != null && row.pin_y != null ? { x: row.pin_x, y: row.pin_y } : null,
      timestamp: row.created_at.toISOString(),
    })),
  });
});

commentRoutes.post("/:workId/comments", requireAuth, async (c) => {
  const user = c.get("user");
  const workId = c.req.param("workId");
  const [work] = await sql`select id from works where id = ${workId} limit 1`;
  if (!work) return c.json({ error: "Work not found." }, 404);
  const body = await c.req.json<{ text?: string; pinnedTo?: { x: number; y: number } | null }>();
  const text = (body.text || "").trim();
  if (!text) return c.json({ error: "Write a comment first." }, 400);

  const [row] = await sql<
    { id: string; text: string; pin_x: number | null; pin_y: number | null; created_at: Date }[]
  >`
    insert into comments (id, work_id, author_id, text, pin_x, pin_y)
    values (
      ${newId("c")}, ${workId}, ${user.id}, ${text},
      ${body.pinnedTo?.x ?? null}, ${body.pinnedTo?.y ?? null}
    )
    returning id, text, pin_x, pin_y, created_at
  `;

  return c.json(
    {
      comment: {
        id: row.id,
        author: user.name,
        text: row.text,
        pinnedTo: row.pin_x != null && row.pin_y != null ? { x: row.pin_x, y: row.pin_y } : null,
        timestamp: row.created_at.toISOString(),
      },
    },
    201,
  );
});
