import { Hono } from "hono";
import { publicWork, sql, type WorkRow } from "../db.js";
import { readUserFromRequest, requireAuth, type Authed } from "../lib/auth-mw.js";
import { notify } from "../lib/notify.js";
import { assertUpload, isStorageReady, putWorkFile } from "../lib/storage.js";
import { newId } from "../lib/tokens.js";

export const workRoutes = new Hono<{ Variables: Authed }>();

workRoutes.get("/", async (c) => {
  const q = (c.req.query("q") || "").trim();
  const medium = (c.req.query("medium") || "").trim();
  const kind = (c.req.query("kind") || "").trim();
  const following = c.req.query("following") === "1";
  const me = following ? await readUserFromRequest(c) : null;
  if (following && !me) return c.json({ works: [] });

  const like = q ? `%${q}%` : null;
  if (following && me) {
    const originals = await sql<WorkRow[]>`
      select w.*, u.name as artist_name, u.handle as artist_handle, u.verified as artist_verified
      from works w
      join users u on u.id = w.artist_id
      where w.artist_id in (select followee_id from follows where follower_id = ${me.id})
        and (${medium} = '' or lower(replace(w.medium, ' ', '-')) = ${medium.toLowerCase()})
        and (${kind} = '' or w.kind = ${kind})
      order by w.created_at desc
      limit 80
    `;
    const boosted = await sql<(WorkRow & { reposted_by: string; reposted_by_name: string })[]>`
      select w.*, u.name as artist_name, u.handle as artist_handle, u.verified as artist_verified,
             ru.handle as reposted_by, ru.name as reposted_by_name
      from reposts r
      join works w on w.id = r.work_id
      join users u on u.id = w.artist_id
      join users ru on ru.id = r.user_id
      where r.user_id in (select followee_id from follows where follower_id = ${me.id})
        and w.artist_id <> r.user_id
        and (${medium} = '' or lower(replace(w.medium, ' ', '-')) = ${medium.toLowerCase()})
        and (${kind} = '' or w.kind = ${kind})
      order by r.created_at desc
      limit 80
    `;
    const seen = new Set<string>();
    const works = [...boosted, ...originals].filter((work) => {
      if (seen.has(work.id)) return false;
      seen.add(work.id);
      return true;
    });
    return c.json({ works: works.map(publicWork) });
  }

  const works = await sql<WorkRow[]>`
    select w.*, u.name as artist_name, u.handle as artist_handle, u.verified as artist_verified
    from works w
    join users u on u.id = w.artist_id
    where (${like}::text is null or w.title ilike ${like} or u.name ilike ${like} or u.handle ilike ${like} or w.medium ilike ${like})
      and (${medium} = '' or lower(replace(w.medium, ' ', '-')) = ${medium.toLowerCase()})
      and (${kind} = '' or w.kind = ${kind})
    order by w.created_at desc
    limit 100
  `;
  return c.json({ works: works.map(publicWork) });
});

workRoutes.post("/:id/like", requireAuth, async (c) => {
  const user = c.get("user");
  const workId = c.req.param("id");
  const [work] = await sql<{ id: string; artist_id: string; title: string }[]>`
    select id, artist_id, title from works where id = ${workId} limit 1
  `;
  if (!work) return c.json({ error: "Work not found." }, 404);
  const inserted = await sql<{ user_id: string }[]>`
    insert into likes (user_id, work_id) values (${user.id}, ${work.id})
    on conflict do nothing
    returning user_id
  `;
  if (inserted[0]) {
    await notify({
      userId: work.artist_id,
      fromId: user.id,
      workId: work.id,
      type: "like",
      text: `cheered ${work.title}`,
    });
  }
  const [count] = await sql<{ n: number }[]>`select count(*)::int as n from likes where work_id = ${work.id}`;
  return c.json({ liked: true, count: count.n });
});

workRoutes.delete("/:id/like", requireAuth, async (c) => {
  const user = c.get("user");
  const workId = c.req.param("id");
  await sql`delete from likes where user_id = ${user.id} and work_id = ${workId}`;
  const [count] = await sql<{ n: number }[]>`select count(*)::int as n from likes where work_id = ${workId}`;
  return c.json({ liked: false, count: count.n });
});

workRoutes.post("/:id/repost", requireAuth, async (c) => {
  const user = c.get("user");
  const workId = c.req.param("id");
  const [work] = await sql<{ id: string; artist_id: string; title: string }[]>`
    select id, artist_id, title from works where id = ${workId} limit 1
  `;
  if (!work) return c.json({ error: "Work not found." }, 404);
  if (work.artist_id === user.id) {
    return c.json({ error: "That's already on your profile." }, 400);
  }
  const inserted = await sql<{ user_id: string }[]>`
    insert into reposts (user_id, work_id) values (${user.id}, ${work.id})
    on conflict do nothing
    returning user_id
  `;
  if (inserted[0]) {
    await notify({
      userId: work.artist_id,
      fromId: user.id,
      workId: work.id,
      type: "repost",
      text: `shared ${work.title}`,
    });
  }
  return c.json({ reposted: true });
});

workRoutes.delete("/:id/repost", requireAuth, async (c) => {
  const user = c.get("user");
  const workId = c.req.param("id");
  await sql`delete from reposts where user_id = ${user.id} and work_id = ${workId}`;
  return c.json({ reposted: false });
});

workRoutes.get("/:id/repost", requireAuth, async (c) => {
  const user = c.get("user");
  const workId = c.req.param("id");
  const [mine] = await sql<{ n: number }[]>`
    select count(*)::int as n from reposts where user_id = ${user.id} and work_id = ${workId}
  `;
  return c.json({ reposted: mine.n > 0 });
});

workRoutes.get("/:id/like", requireAuth, async (c) => {
  const user = c.get("user");
  const workId = c.req.param("id");
  const [mine] = await sql<{ n: number }[]>`
    select count(*)::int as n from likes where user_id = ${user.id} and work_id = ${workId}
  `;
  const [count] = await sql<{ n: number }[]>`select count(*)::int as n from likes where work_id = ${workId}`;
  return c.json({ liked: mine.n > 0, count: count.n });
});

workRoutes.get("/:id", async (c) => {
  const [work] = await sql<WorkRow[]>`
    select w.*, u.name as artist_name, u.handle as artist_handle, u.verified as artist_verified
    from works w
    join users u on u.id = w.artist_id
    where w.id = ${c.req.param("id")}
    limit 1
  `;
  if (!work) return c.json({ error: "Work not found." }, 404);
  await sql`update works set views = views + 1 where id = ${work.id}`;
  return c.json({ work: publicWork({ ...work, views: work.views + 1 }) });
});

workRoutes.post("/", requireAuth, async (c) => {
  const user = c.get("user");
  const contentType = c.req.header("content-type") || "";
  let title = "Untitled";
  let medium = "Digital Painting";
  let description = "";
  let mediaUrl = "";
  let color = "#121612";
  let remixable = false;
  let kind = "image";
  let license = "All Rights Reserved";
  let bodyText = "";
  let tools: string[] = [];
  let file: File | null = null;
  let cover: File | null = null;
  let coverUrl = "";

  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData();
    title = String(form.get("title") || title);
    medium = String(form.get("medium") || medium);
    description = String(form.get("description") || "");
    mediaUrl = String(form.get("mediaUrl") || form.get("url") || "");
    color = String(form.get("color") || color);
    remixable = String(form.get("remixable")) === "true";
    kind = String(form.get("kind") || kind);
    license = String(form.get("license") || license);
    bodyText = String(form.get("body") || "");
    const rawTools = form.get("tools");
    if (typeof rawTools === "string" && rawTools) {
      try {
        const parsed = JSON.parse(rawTools);
        if (Array.isArray(parsed)) tools = parsed.map(String);
      } catch {
        tools = rawTools.split(",").map((t) => t.trim()).filter(Boolean);
      }
    }
    const uploaded = form.get("file");
    if (uploaded instanceof File && uploaded.size > 0) file = uploaded;
    const uploadedCover = form.get("cover");
    if (uploadedCover instanceof File && uploadedCover.size > 0) cover = uploadedCover;
  } else {
    const body = await c.req.json<{
      title?: string;
      medium?: string;
      description?: string;
      mediaUrl?: string;
      color?: string;
      remixable?: boolean;
      kind?: string;
      license?: string;
      body?: string;
      tools?: string[];
    }>();
    title = body.title || title;
    medium = body.medium || medium;
    description = body.description || "";
    mediaUrl = body.mediaUrl || "";
    color = body.color || color;
    remixable = Boolean(body.remixable);
    kind = body.kind || kind;
    license = body.license || license;
    bodyText = body.body || "";
    if (Array.isArray(body.tools)) tools = body.tools.map(String);
  }

  const workId = newId("work");
  if (file || cover) {
    if (!isStorageReady()) {
      return c.json({ error: "File storage is not ready yet. Add a Railway Bucket to artshare-api." }, 503);
    }
  }
  if (file) {
    const problem = assertUpload(file, kind);
    if (problem) return c.json({ error: problem }, 400);
    try {
      mediaUrl = await putWorkFile(user.id, workId, file, kind);
    } catch (err) {
      console.error(err);
      return c.json({ error: "Could not store that file." }, 500);
    }
  } else if ((kind === "image" || kind === "music") && !mediaUrl) {
    return c.json({ error: kind === "music" ? "Add the song before you publish." : "Add a photo before you publish." }, 400);
  }
  if (cover) {
    const problem = assertUpload(cover, "image");
    if (problem) return c.json({ error: problem }, 400);
    try {
      coverUrl = await putWorkFile(user.id, `${workId}-cover`, cover, "image");
    } catch (err) {
      console.error(err);
      return c.json({ error: "Could not store that cover." }, 500);
    }
  }

  const [work] = await sql<WorkRow[]>`
    insert into works (
      id, artist_id, title, medium, description, media_url, color, remixable,
      download_permitted, tools, kind, license, body, cover_url
    )
    values (
      ${workId}, ${user.id}, ${title.trim()}, ${medium}, ${description || null},
      ${mediaUrl || null}, ${color}, ${remixable}, ${remixable},
      ${JSON.stringify(tools)}::jsonb, ${kind}, ${license}, ${bodyText || null},
      ${coverUrl || null}
    )
    returning *
  `;

  return c.json(
    {
      work: publicWork({
        ...work,
        artist_name: user.name,
        artist_handle: user.handle,
        artist_verified: user.verified,
      }),
    },
    201,
  );
});
