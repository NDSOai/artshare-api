import { Hono } from "hono";
import { sql } from "../db.js";
import { requireAuth, type Authed } from "../lib/auth-mw.js";
import { notify } from "../lib/notify.js";
import { assertCooldown, commentsLastHour, lastCommentAt, limited } from "../lib/rate-limit.js";
import { newId } from "../lib/tokens.js";

export const commentRoutes = new Hono<{ Variables: Authed }>();

type Revision = { text: string; at: string };

function asRevisions(value: unknown): Revision[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object" && typeof (item as Revision).text === "string")
    .map((item) => ({
      text: String((item as Revision).text).slice(0, 500),
      at: String((item as Revision).at || ""),
    }))
    .slice(-3);
}

function publicComment(row: {
  id: string;
  text: string;
  pin_x: number | null;
  pin_y: number | null;
  created_at: Date;
  author: string;
  author_handle?: string;
  revisions?: unknown;
}) {
  return {
    id: row.id,
    author: row.author,
    authorHandle: row.author_handle,
    text: row.text,
    pinnedTo: row.pin_x != null && row.pin_y != null ? { x: row.pin_x, y: row.pin_y } : null,
    timestamp: row.created_at.toISOString(),
    revisions: asRevisions(row.revisions),
  };
}

commentRoutes.get("/:workId/comments", async (c) => {
  const rows = await sql<
    {
      id: string;
      text: string;
      pin_x: number | null;
      pin_y: number | null;
      created_at: Date;
      author: string;
      author_handle: string;
      revisions: unknown;
    }[]
  >`
    select c.id, c.text, c.pin_x, c.pin_y, c.created_at, c.revisions, u.name as author, u.handle as author_handle
    from comments c
    join users u on u.id = c.author_id
    where c.work_id = ${c.req.param("workId")}
    order by c.created_at asc
  `;
  return c.json({
    comments: rows.map(publicComment),
  });
});

commentRoutes.post("/:workId/comments", requireAuth, async (c) => {
  const user = c.get("user");
  const workId = c.req.param("workId");
  const [work] = await sql<{ id: string; artist_id: string; title: string }[]>`
    select id, artist_id, title from works where id = ${workId} limit 1
  `;
  if (!work) return c.json({ error: "Work not found." }, 404);
  const body = await c.req.json<{ text?: string; pinnedTo?: { x: number; y: number } | null }>();
  const text = (body.text || "").trim().slice(0, 500);
  if (!text) return c.json({ error: "Write a comment first." }, 400);
  const tooSoon = await assertCooldown(await lastCommentAt(user.id), 15_000, "comment");
  if (tooSoon) return limited(c, tooSoon);
  if ((await commentsLastHour(user.id)) >= 20) {
    return limited(c, { error: "You can comment again in a bit.", retryAfter: 3600 });
  }

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

  await notify({
    userId: work.artist_id,
    fromId: user.id,
    workId: work.id,
    type: "comment",
    text: `commented on ${work.title}`,
  });

  return c.json(
    {
      comment: publicComment({
        ...row,
        author: user.name,
        author_handle: user.handle,
        revisions: [],
      }),
    },
    201,
  );
});

commentRoutes.patch("/:workId/comments/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const workId = c.req.param("workId");
  const id = c.req.param("id");
  const [existing] = await sql<
    {
      id: string;
      author_id: string;
      text: string;
      pin_x: number | null;
      pin_y: number | null;
      created_at: Date;
      revisions: unknown;
    }[]
  >`
    select id, author_id, text, pin_x, pin_y, created_at, revisions
    from comments
    where id = ${id} and work_id = ${workId}
    limit 1
  `;
  if (!existing) return c.json({ error: "Comment not found." }, 404);
  if (existing.author_id !== user.id) return c.json({ error: "You can only edit your own comment." }, 403);

  const body = await c.req.json<{ text?: string }>().catch(() => ({} as { text?: string }));
  const text = (body.text || "").trim().slice(0, 500);
  if (!text) return c.json({ error: "Write a comment first." }, 400);
  if (text === existing.text) {
    return c.json({
      comment: publicComment({
        ...existing,
        author: user.name,
        author_handle: user.handle,
      }),
    });
  }

  const revisions = asRevisions(existing.revisions);
  if (revisions.length >= 3) {
    return c.json({ error: "This note can only be revised three times." }, 400);
  }
  const nextRevisions = [...revisions, { text: existing.text, at: new Date().toISOString() }];

  const [row] = await sql<
    {
      id: string;
      text: string;
      pin_x: number | null;
      pin_y: number | null;
      created_at: Date;
      revisions: unknown;
    }[]
  >`
    update comments
    set text = ${text}, revisions = ${sql.json(nextRevisions)}
    where id = ${existing.id}
    returning id, text, pin_x, pin_y, created_at, revisions
  `;
  return c.json({
    comment: publicComment({
      ...row,
      author: user.name,
      author_handle: user.handle,
    }),
  });
});

commentRoutes.delete("/:workId/comments/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const workId = c.req.param("workId");
  const id = c.req.param("id");
  const [existing] = await sql<{ id: string; author_id: string }[]>`
    select id, author_id from comments where id = ${id} and work_id = ${workId} limit 1
  `;
  if (!existing) return c.json({ error: "Comment not found." }, 404);
  if (existing.author_id !== user.id) return c.json({ error: "You can only delete your own comment." }, 403);
  await sql`delete from comments where id = ${existing.id}`;
  return c.json({ ok: true });
});
