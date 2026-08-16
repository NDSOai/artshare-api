import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { publicWork, sql, type WorkRow } from "../db.js";
import { readUserFromRequest, requireAuth, type Authed } from "../lib/auth-mw.js";
import { notify } from "../lib/notify.js";
import { assertCooldown, lastRepostAt, lastWorkAt, limited, repostsLastHour } from "../lib/rate-limit.js";
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
    const boosted = await sql<(WorkRow & { reposted_by: string; reposted_by_name: string; repost_caption: string })[]>`
      select w.*, u.name as artist_name, u.handle as artist_handle, u.verified as artist_verified,
             ru.handle as reposted_by, ru.name as reposted_by_name, r.caption as repost_caption
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

function asCaption(value: unknown) {
  return String(value ?? "").trim().slice(0, 280);
}

workRoutes.post("/:id/repost", requireAuth, async (c) => {
  const user = c.get("user");
  const workId = c.req.param("id");
  const body = await c.req.json<{ caption?: string }>().catch(() => ({} as { caption?: string }));
  const caption = asCaption(body.caption);
  const [work] = await sql<{ id: string; artist_id: string; title: string }[]>`
    select id, artist_id, title from works where id = ${workId} limit 1
  `;
  if (!work) return c.json({ error: "Work not found." }, 404);
  if (work.artist_id === user.id) {
    return c.json({ error: "That's already on your profile." }, 400);
  }
  const [existing] = await sql<{ user_id: string }[]>`
    select user_id from reposts where user_id = ${user.id} and work_id = ${work.id} limit 1
  `;
  if (existing) {
    await sql`update reposts set caption = ${caption} where user_id = ${user.id} and work_id = ${work.id}`;
    return c.json({ reposted: true, caption });
  }
  if ((await repostsLastHour(user.id)) >= 10) {
    return limited(c, { error: "You can share again in a bit.", retryAfter: 3600 });
  }
  const tooSoon = await assertCooldown(await lastRepostAt(user.id), 20_000, "share");
  if (tooSoon) return limited(c, tooSoon);
  await sql`
    insert into reposts (user_id, work_id, caption) values (${user.id}, ${work.id}, ${caption})
  `;
  await notify({
    userId: work.artist_id,
    fromId: user.id,
    workId: work.id,
    type: "repost",
    text: `shared ${work.title}`,
  });
  return c.json({ reposted: true, caption });
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
  const [mine] = await sql<{ caption: string }[]>`
    select caption from reposts where user_id = ${user.id} and work_id = ${workId} limit 1
  `;
  return c.json({ reposted: Boolean(mine), caption: mine?.caption ?? "" });
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
  const shares = await sql<{ handle: string; name: string; caption: string; created_at: Date }[]>`
    select u.handle, u.name, r.caption, r.created_at
    from reposts r
    join users u on u.id = r.user_id
    where r.work_id = ${work.id}
    order by r.created_at desc
    limit 40
  `;
  const [count] = await sql<{ n: number }[]>`
    select count(*)::int as n from reposts where work_id = ${work.id}
  `;
  return c.json({
    work: publicWork({ ...work, views: work.views + 1, share_count: count?.n ?? shares.length }),
    shares: shares.map((row) => ({
      handle: row.handle,
      name: row.name,
      caption: row.caption?.trim() || undefined,
      at: row.created_at.toISOString(),
    })),
  });
});

function guessUploadType(name: string) {
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.webp$/i.test(name)) return "image/webp";
  if (/\.mp3$/i.test(name)) return "audio/mpeg";
  if (/\.(m4a|aac)$/i.test(name)) return "audio/mp4";
  return "";
}

function asUpload(value: unknown): File | null {
  if (!value || typeof value !== "object") return null;
  const blob = value as Blob & { name?: string; size?: number; arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof blob.size !== "number" || blob.size <= 0 || typeof blob.arrayBuffer !== "function") return null;
  const name = typeof blob.name === "string" && blob.name ? blob.name : "upload";
  const type = blob.type || guessUploadType(name) || "application/octet-stream";
  if (value instanceof File) {
    return value.type ? value : new File([value], name, { type });
  }
  try {
    return new File([value as Blob], name, { type });
  } catch {
    return value as File;
  }
}

const MAX_PUBLISH_BYTES = 22 * 1024 * 1024;

async function readForm(c: {
  req: {
    header: (name: string) => string | undefined;
    arrayBuffer: () => Promise<ArrayBuffer>;
    formData: () => Promise<FormData>;
  };
}) {
  const length = Number(c.req.header("content-length") || 0);
  if (length > MAX_PUBLISH_BYTES) {
    throw new Error("That file is too large.");
  }
  try {
    return await c.req.formData();
  } catch (first) {
    console.error("[works.formData]", first);
    const type = c.req.header("content-type") || "";
    const buf = await c.req.arrayBuffer();
    if (buf.byteLength > MAX_PUBLISH_BYTES) {
      throw new Error("That file is too large.");
    }
    return new Response(buf, { headers: { "content-type": type } }).formData();
  }
}

function asTools(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

workRoutes.post(
  "/",
  requireAuth,
  bodyLimit({
    maxSize: MAX_PUBLISH_BYTES,
    onError: (c) => c.json({ error: "That file is too large." }, 413),
  }),
  async (c) => {
  const user = c.get("user");
  try {
  const tooSoon = await assertCooldown(await lastWorkAt(user.id), 60 * 60 * 1000, "publish");
  if (tooSoon) return limited(c, tooSoon);
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

  const useForm = contentType.includes("multipart/form-data") || !contentType.includes("json");
  if (useForm) {
    const form = await readForm(c);
    title = String(form.get("title") || title);
    medium = String(form.get("medium") || medium);
    description = String(form.get("description") || "");
    mediaUrl = String(form.get("mediaUrl") || form.get("url") || "");
    color = String(form.get("color") || color);
    remixable = String(form.get("remixable")) === "true";
    kind = String(form.get("kind") || kind);
    license = String(form.get("license") || license);
    bodyText = String(form.get("body") || "");
    tools = asTools(form.get("tools"));
    file = asUpload(form.get("file"));
    cover = asUpload(form.get("cover"));
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
    tools = asTools(body.tools);
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
  } catch (err) {
    console.error("[works.create]", err);
    const message = err instanceof Error ? err.message : "";
    if (/too large/i.test(message)) {
      return c.json({ error: "That file is too large." }, 413);
    }
    if (/formdata|multipart|parse/i.test(message)) {
      return c.json({ error: "Could not read that upload. Try a smaller JPEG or PNG." }, 500);
    }
    return c.json({ error: "Could not publish that work. Try again in a moment." }, 500);
  }
});
