import { Hono } from "hono";
import { publicWork, sql, type WorkRow } from "../db.js";
import { requireAuth, type Authed } from "../lib/auth-mw.js";
import { newId } from "../lib/tokens.js";

export const collectionRoutes = new Hono<{ Variables: Authed }>();

collectionRoutes.use("*", requireAuth);

collectionRoutes.get("/", async (c) => {
  const me = c.get("user");
  const rows = await sql<{ id: string; name: string; cover_color: string; n: number }[]>`
    select c.id, c.name, c.cover_color, count(cw.work_id)::int as n
    from collections c
    left join collection_works cw on cw.collection_id = c.id
    where c.owner_id = ${me.id}
    group by c.id
    order by c.created_at desc
  `;
  return c.json({
    collections: rows.map((row) => ({
      id: row.id,
      name: row.name,
      coverColor: row.cover_color,
      workCount: row.n,
    })),
  });
});

collectionRoutes.post("/", async (c) => {
  const me = c.get("user");
  const body = await c.req.json<{ name?: string }>();
  const name = (body.name || "").trim().slice(0, 60) || "Untitled";
  const [row] = await sql<{ id: string; name: string; cover_color: string }[]>`
    insert into collections (id, owner_id, name)
    values (${newId("col")}, ${me.id}, ${name})
    returning id, name, cover_color
  `;
  return c.json({ collection: { id: row.id, name: row.name, coverColor: row.cover_color, workCount: 0 } }, 201);
});

collectionRoutes.get("/:id", async (c) => {
  const me = c.get("user");
  const [col] = await sql<{ id: string; name: string; cover_color: string; owner_name: string }[]>`
    select c.id, c.name, c.cover_color, u.name as owner_name
    from collections c
    join users u on u.id = c.owner_id
    where c.id = ${c.req.param("id")} and c.owner_id = ${me.id}
    limit 1
  `;
  if (!col) return c.json({ error: "Collection not found." }, 404);
  const works = await sql<WorkRow[]>`
    select w.*, u.name as artist_name, u.handle as artist_handle, u.verified as artist_verified
    from collection_works cw
    join works w on w.id = cw.work_id
    join users u on u.id = w.artist_id
    where cw.collection_id = ${col.id}
    order by cw.created_at desc
  `;
  return c.json({
    collection: { id: col.id, name: col.name, coverColor: col.cover_color, owner: col.owner_name },
    works: works.map(publicWork),
  });
});

collectionRoutes.post("/:id/works", async (c) => {
  const me = c.get("user");
  const [col] = await sql<{ id: string }[]>`
    select id from collections where id = ${c.req.param("id")} and owner_id = ${me.id} limit 1
  `;
  if (!col) return c.json({ error: "Collection not found." }, 404);
  const body = await c.req.json<{ workId?: string }>();
  const workId = body.workId || "";
  const [work] = await sql`select id from works where id = ${workId} limit 1`;
  if (!work) return c.json({ error: "Work not found." }, 404);
  await sql`
    insert into collection_works (collection_id, work_id)
    values (${col.id}, ${workId})
    on conflict do nothing
  `;
  return c.json({ saved: true });
});
