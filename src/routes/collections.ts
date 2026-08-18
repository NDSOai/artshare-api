import { Hono } from "hono";
import { publicWorks, sql, type WorkRow } from "../db.js";
import { readUserFromRequest, requireAuth, type Authed } from "../lib/auth-mw.js";
import { ensureFavorites, isFavoritesName } from "../lib/collections.js";
import { notify } from "../lib/notify.js";
import { limitPublicGet } from "../lib/rate-limit.js";
import { newId } from "../lib/tokens.js";
import { cachePublic } from "../lib/http-cache.js";

export const collectionRoutes = new Hono<{ Variables: Authed }>();

type CollectionRow = {
  id: string;
  name: string;
  cover_color: string;
  description: string;
  tags: unknown;
  sort_order: number;
  owner_name?: string;
  owner_handle?: string;
  n?: number;
};

function clip(value: string, max: number) {
  return value.trim().slice(0, max);
}

function asTags(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map(String) : [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    const tag = item.trim().replace(/^#+/, "").slice(0, 32);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 20) break;
  }
  return tags;
}

function publicCollection(row: CollectionRow, extra: Record<string, unknown> = {}) {
  return {
    id: row.id,
    name: row.name,
    coverColor: row.cover_color,
    description: row.description || "",
    tags: asTags(row.tags),
    sortOrder: row.sort_order ?? 0,
    owner: row.owner_name,
    ownerHandle: row.owner_handle,
    workCount: row.n ?? 0,
    locked: isFavoritesName(row.name),
    ...extra,
  };
}

collectionRoutes.get("/", requireAuth, async (c) => {
  const me = c.get("user");
  await ensureFavorites(me.id);
  const rows = await sql<CollectionRow[]>`
    select c.id, c.name, c.cover_color, c.description, c.tags, c.sort_order, count(cw.work_id)::int as n
    from collections c
    left join collection_works cw on cw.collection_id = c.id
    where c.owner_id = ${me.id}
    group by c.id
    order by c.sort_order asc, (lower(c.name) = 'favorites') desc, c.created_at desc
  `;
  return c.json({
    collections: rows.map((row) => publicCollection(row)),
  });
});

collectionRoutes.get("/search", async (c) => {
  const blocked = limitPublicGet(c, "collections-search", 80);
  if (blocked) return blocked;
  const q = (c.req.query("q") || "").trim().replace(/^#+/, "").replace(/[%_]/g, "").slice(0, 80);
  if (q.length < 2) return c.json({ collections: [] });
  const like = `%${q}%`;
  const rows = await sql<CollectionRow[]>`
    select c.id, c.name, c.cover_color, c.description, c.tags, c.sort_order,
           u.name as owner_name, u.handle as owner_handle, count(cw.work_id)::int as n
    from collections c
    join users u on u.id = c.owner_id
    left join collection_works cw on cw.collection_id = c.id
    where lower(c.name) <> 'favorites'
      and (
        c.name ilike ${like}
        or c.description ilike ${like}
        or exists (
          select 1 from jsonb_array_elements_text(coalesce(c.tags, '[]'::jsonb)) t
          where t ilike ${like}
        )
      )
    group by c.id, u.name, u.handle
    order by c.created_at desc
    limit 40
  `;
  cachePublic(c, 120);
  return c.json({ collections: rows.map((row) => publicCollection(row)) });
});

collectionRoutes.post("/", requireAuth, async (c) => {
  const me = c.get("user");
  const body = await c.req.json<{ name?: string; description?: string; tags?: string[] }>();
  const name = clip(body.name || "", 60) || "Untitled";
  if (isFavoritesName(name)) {
    const id = await ensureFavorites(me.id);
    const [row] = await sql<CollectionRow[]>`
      select c.id, c.name, c.cover_color, c.description, c.tags, c.sort_order, count(cw.work_id)::int as n
      from collections c
      left join collection_works cw on cw.collection_id = c.id
      where c.id = ${id}
      group by c.id
    `;
    return c.json({ collection: publicCollection(row) });
  }
  const [next] = await sql<{ n: number }[]>`
    select coalesce(max(sort_order), -1)::int + 1 as n from collections where owner_id = ${me.id}
  `;
  const description = clip(String(body.description ?? ""), 500);
  const tags = asTags(body.tags);
  const [row] = await sql<CollectionRow[]>`
    insert into collections (id, owner_id, name, description, tags, sort_order)
    values (${newId("col")}, ${me.id}, ${name}, ${description}, ${sql.json(tags)}, ${next?.n ?? 0})
    returning id, name, cover_color, description, tags, sort_order
  `;
  return c.json({ collection: publicCollection({ ...row, n: 0 }) }, 201);
});

collectionRoutes.patch("/order", requireAuth, async (c) => {
  const me = c.get("user");
  const body = await c.req.json<{ ids?: string[] }>().catch(() => ({ ids: [] as string[] }));
  const wanted = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
  const mine = await sql<{ id: string }[]>`
    select id from collections
    where owner_id = ${me.id}
    order by sort_order asc, (lower(name) = 'favorites') desc, created_at desc
  `;
  const mineIds = mine.map((row) => row.id);
  const mineSet = new Set(mineIds);
  const ordered = [...wanted.filter((id) => mineSet.has(id)), ...mineIds.filter((id) => !wanted.includes(id))];
  await sql.begin(async (tx) => {
    for (let i = 0; i < ordered.length; i++) {
      await tx`update collections set sort_order = ${i} where id = ${ordered[i]} and owner_id = ${me.id}`;
    }
  });
  return c.json({ ok: true, ids: ordered });
});

collectionRoutes.get("/:id", async (c) => {
  const blocked = limitPublicGet(c, "collections-get", 120);
  if (blocked) return blocked;
  const me = await readUserFromRequest(c);
  const [col] = await sql<(CollectionRow & { owner_id: string })[]>`
    select c.id, c.name, c.cover_color, c.description, c.tags, c.sort_order,
           c.owner_id, u.name as owner_name, u.handle as owner_handle
    from collections c
    join users u on u.id = c.owner_id
    where c.id = ${c.req.param("id")}
    limit 1
  `;
  if (!col) return c.json({ error: "Collection not found." }, 404);
  const works = await sql<WorkRow[]>`
    select w.*, u.name as artist_name, u.handle as artist_handle, u.verified as artist_verified
    from collection_works cw
    join works w on w.id = cw.work_id
    join users u on u.id = w.artist_id
    where cw.collection_id = ${col.id}
    order by cw.sort_order asc, cw.created_at desc
  `;
  return c.json({
    collection: publicCollection(col, { mine: Boolean(me && me.id === col.owner_id) }),
    works: await publicWorks(works),
  });
});

collectionRoutes.patch("/:id", requireAuth, async (c) => {
  const me = c.get("user");
  const [existing] = await sql<CollectionRow[]>`
    select id, name, cover_color, description, tags, sort_order
    from collections
    where id = ${c.req.param("id")} and owner_id = ${me.id}
    limit 1
  `;
  if (!existing) return c.json({ error: "Collection not found." }, 404);
  const body = await c.req.json<{ name?: string; description?: string; tags?: string[] }>().catch(
    () => ({}) as { name?: string; description?: string; tags?: string[] },
  );
  let name = existing.name;
  if (body.name !== undefined && !isFavoritesName(existing.name)) {
    name = clip(String(body.name), 60) || existing.name;
    if (isFavoritesName(name)) return c.json({ error: "Favorites stays on your account." }, 400);
  }
  const description = body.description !== undefined ? clip(String(body.description), 500) : existing.description;
  const tags = body.tags !== undefined ? asTags(body.tags) : asTags(existing.tags);
  const [row] = await sql<CollectionRow[]>`
    update collections
    set name = ${name}, description = ${description}, tags = ${sql.json(tags)}
    where id = ${existing.id} and owner_id = ${me.id}
    returning id, name, cover_color, description, tags, sort_order
  `;
  return c.json({ collection: publicCollection(row, { mine: true }) });
});

collectionRoutes.patch("/:id/works/order", requireAuth, async (c) => {
  const me = c.get("user");
  const [col] = await sql<{ id: string }[]>`
    select id from collections where id = ${c.req.param("id")} and owner_id = ${me.id} limit 1
  `;
  if (!col) return c.json({ error: "Collection not found." }, 404);
  const body = await c.req.json<{ workIds?: string[] }>().catch(() => ({ workIds: [] as string[] }));
  const wanted = Array.isArray(body.workIds) ? body.workIds.map(String).filter(Boolean) : [];
  const mine = await sql<{ work_id: string }[]>`
    select work_id from collection_works
    where collection_id = ${col.id}
    order by sort_order asc, created_at desc
  `;
  const mineIds = mine.map((row) => row.work_id);
  const mineSet = new Set(mineIds);
  const ordered = [...wanted.filter((id) => mineSet.has(id)), ...mineIds.filter((id) => !wanted.includes(id))];
  await sql.begin(async (tx) => {
    for (let i = 0; i < ordered.length; i++) {
      await tx`
        update collection_works set sort_order = ${i}
        where collection_id = ${col.id} and work_id = ${ordered[i]}
      `;
    }
  });
  return c.json({ ok: true, workIds: ordered });
});

collectionRoutes.post("/:id/works", requireAuth, async (c) => {
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
  const [next] = await sql<{ n: number }[]>`
    select coalesce(max(sort_order), -1)::int + 1 as n from collection_works where collection_id = ${col.id}
  `;
  const inserted = await sql<{ work_id: string }[]>`
    insert into collection_works (collection_id, work_id, sort_order)
    values (${col.id}, ${workId}, ${next?.n ?? 0})
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

collectionRoutes.delete("/:id", requireAuth, async (c) => {
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
