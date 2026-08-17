import { Hono } from "hono";
import { publicWork, sql, type WorkRow } from "../db.js";
import { requireAuth, type Authed } from "../lib/auth-mw.js";
import { ensureFavorites, isFavoritesName } from "../lib/collections.js";
import { notify } from "../lib/notify.js";
import { newId } from "../lib/tokens.js";

export const collectionRoutes = new Hono<{ Variables: Authed }>();

collectionRoutes.use("*", requireAuth);

collectionRoutes.get("/", async (c) => {
  const me = c.get("user");
  await ensureFavorites(me.id);
  const rows = await sql<{ id: string; name: string; cover_color: string; n: number }[]>`
    select c.id, c.name, c.cover_color, count(cw.work_id)::int as n
    from collections c
    left join collection_works cw on cw.collection_id = c.id
    where c.owner_id = ${me.id}
    group by c.id
    order by (lower(c.name) = 'favorites') desc, c.created_at desc
  `;
  return c.json({
    collections: rows.map((row) => ({
      id: row.id,
      name: row.name,
      coverColor: row.cover_color,
      workCount: row.n,
      locked: isFavoritesName(row.name),
    })),
  });
});

collectionRoutes.post("/", async (c) => {
  const me = c.get("user");
  const body = await c.req.json<{ name?: string }>();
  const name = (body.name || "").trim().slice(0, 60) || "Untitled";
  if (isFavoritesName(name)) {
    const id = await ensureFavorites(me.id);
    const [row] = await sql<{ id: string; name: string; cover_color: string; n: number }[]>`
      select c.id, c.name, c.cover_color, count(cw.work_id)::int as n
      from collections c
      left join collection_works cw on cw.collection_id = c.id
      where c.id = ${id}
      group by c.id
    `;
    return c.json({
      collection: {
        id: row.id,
        name: row.name,
        coverColor: row.cover_color,
        workCount: row.n,
        locked: true,
      },
    });
  }
  const [row] = await sql<{ id: string; name: string; cover_color: string }[]>`
    insert into collections (id, owner_id, name)
    values (${newId("col")}, ${me.id}, ${name})
    returning id, name, cover_color
  `;
  return c.json({ collection: { id: row.id, name: row.name, coverColor: row.cover_color, workCount: 0, locked: false } }, 201);
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
    collection: {
      id: col.id,
      name: col.name,
      coverColor: col.cover_color,
      owner: col.owner_name,
      locked: isFavoritesName(col.name),
    },
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
  const [work] = await sql<{ id: string; artist_id: string; title: string }[]>`
    select id, artist_id, title from works where id = ${workId} limit 1
  `;
  if (!work) return c.json({ error: "Work not found." }, 404);
  const inserted = await sql<{ work_id: string }[]>`
    insert into collection_works (collection_id, work_id)
    values (${col.id}, ${workId})
    on conflict do nothing
    returning work_id
  `;
  if (inserted[0]) {
    await notify({
      userId: work.artist_id,
      fromId: me.id,
      workId: work.id,
      type: "collect",
      text: `added ${work.title} to a collection`,
    });
  }
  return c.json({ saved: true });
});

collectionRoutes.delete("/:id", async (c) => {
  const me = c.get("user");
  const [col] = await sql<{ id: string; name: string }[]>`
    select id, name from collections where id = ${c.req.param("id")} and owner_id = ${me.id} limit 1
  `;
  if (!col) return c.json({ error: "Collection not found." }, 404);
  if (isFavoritesName(col.name)) {
    return c.json({ error: "Favorites stays on your account." }, 400);
  }
  await sql`delete from collections where id = ${col.id} and owner_id = ${me.id}`;
  return c.json({ deleted: true });
});
