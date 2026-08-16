import { Hono } from "hono";
import { publicWork, sql, type WorkRow } from "../db.js";
import { readUserFromRequest, requireAuth, type Authed } from "../lib/auth-mw.js";
import { notify } from "../lib/notify.js";
import { assertCooldown, lastRepostAt, lastWorkAt, limited, repostsLastHour } from "../lib/rate-limit.js";
import { parseMultipart, type FormFile } from "../lib/multipart.js";
import { assertUpload, isStorageReady, ownMediaKey, putWorkFile } from "../lib/storage.js";
import { consumeCaptcha } from "../lib/captcha.js";
import { newId } from "../lib/tokens.js";

export const workRoutes = new Hono<{ Variables: Authed }>();

function clip(value: string, max: number) {
  return value.trim().slice(0, max);
}

workRoutes.get("/", async (c) => {
  const q = (c.req.query("q") || "").trim().replace(/[%_]/g, "").slice(0, 80);
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

workRoutes.patch("/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const [existing] = await sql<WorkRow[]>`select * from works where id = ${id} limit 1`;
  if (!existing) return c.json({ error: "Work not found." }, 404);
  if (existing.artist_id !== user.id) return c.json({ error: "You can only edit your own work." }, 403);

  const body = await c.req.json<{
    title?: string;
    medium?: string;
    description?: string;
    color?: string;
    remixable?: boolean;
    license?: string;
    body?: string;
    tools?: string[];
  }>().catch(() => ({} as Record<string, never>));

  const title = clip(String(body.title ?? existing.title), 120) || existing.title;
  const medium = clip(String(body.medium ?? existing.medium), 80) || existing.medium;
  const description = body.description !== undefined ? clip(String(body.description), 500) : existing.description;
  const color = String(body.color ?? existing.color).slice(0, 32);
  const license = clip(String(body.license ?? existing.license ?? "All Rights Reserved"), 80);
  const bodyText = body.body !== undefined ? String(body.body).slice(0, 20_000) : existing.body;
  const tools = Array.isArray(body.tools) ? body.tools.map(String) : existing.tools ?? [];
  const remixable = body.remixable !== undefined ? Boolean(body.remixable) : existing.remixable;

  try {
    const [work] = await sql<WorkRow[]>`
      update works set
        title = ${title},
        medium = ${medium},
        description = ${description || null},
        color = ${color},
        remixable = ${remixable},
        download_permitted = ${remixable},
        tools = ${sql.json(tools)},
        license = ${license},
        body = ${bodyText || null}
      where id = ${existing.id}
      returning *
    `;
    if (!work) return c.json({ error: "Could not save that work." }, 500);
    return c.json({
      work: publicWork({
        ...work,
        artist_name: user.name,
        artist_handle: user.handle,
        artist_verified: user.verified,
      }),
    });
  } catch (err) {
    console.error("[works.update]", err);
    return c.json({ error: "Could not save that work." }, 500);
  }
});

workRoutes.delete("/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const [existing] = await sql<{ id: string; artist_id: string }[]>`
    select id, artist_id from works where id = ${id} limit 1
  `;
  if (!existing) return c.json({ error: "Work not found." }, 404);
  if (existing.artist_id !== user.id) return c.json({ error: "You can only delete your own work." }, 403);
  await sql`delete from works where id = ${existing.id}`;
  return c.json({ deleted: true, id: existing.id });
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

function asUpload(value: FormFile | undefined): FormFile | null {
  if (!value || value.size <= 0) return null;
  if (!value.type) {
    return { ...value, type: guessUploadType(value.name) || "application/octet-stream" };
  }
  return value;
}

const MAX_PUBLISH_BYTES = 22 * 1024 * 1024;

async function readForm(c: {
  req: {
    header: (name: string) => string | undefined;
    arrayBuffer: () => Promise<ArrayBuffer>;
  };
}) {
  const length = Number(c.req.header("content-length") || 0);
  if (length > MAX_PUBLISH_BYTES) {
    throw new Error("That file is too large.");
  }
  const type = c.req.header("content-type") || "";
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (buf.byteLength > MAX_PUBLISH_BYTES) {
    throw new Error("That file is too large.");
  }
  if (!type.includes("multipart/form-data")) {
    throw new Error("Could not read that upload.");
  }
  return parseMultipart(buf, type);
}

function publishFail(err: unknown) {
  const message = err instanceof Error ? err.message : "";
  if (/too large/i.test(message)) return { error: "That file is too large.", status: 413 as const };
  if (/formdata|multipart|boundary|upload/i.test(message)) {
    return { error: "Could not read that upload. Try a smaller JPEG or PNG.", status: 500 as const };
  }
  if (message && message.length < 160 && !/\/src\/|node_modules|at\s+\S+\s+\(/i.test(message)) {
    return { error: message, status: 500 as const };
  }
  return { error: "Could not publish that work. Try again in a moment.", status: 500 as const };
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

workRoutes.post("/", requireAuth, async (c) => {
  const user = c.get("user");
  try {
  const tooSoon = await assertCooldown(await lastWorkAt(user.id), 60 * 60 * 1000, "publish");
  if (tooSoon) return limited(c, tooSoon);
  const contentType = c.req.header("content-type") || "";
  let captchaToken = "";
  let captchaAnswer = "";
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
  let file: FormFile | null = null;
  let cover: FormFile | null = null;
  let coverUrl = "";

  const useForm = contentType.includes("multipart/form-data") || !contentType.includes("json");
  if (useForm) {
    const form = await readForm(c);
    title = String(form.fields.title || title);
    medium = String(form.fields.medium || medium);
    description = String(form.fields.description || "");
    mediaUrl = ownMediaKey(String(form.fields.mediaUrl || form.fields.url || "")) || "";
    color = String(form.fields.color || color);
    remixable = String(form.fields.remixable) === "true";
    kind = String(form.fields.kind || kind);
    license = String(form.fields.license || license);
    bodyText = String(form.fields.body || "");
    tools = asTools(form.fields.tools);
    captchaToken = String(form.fields.captchaToken || "");
    captchaAnswer = String(form.fields.captchaAnswer || "");
    file = asUpload(form.files.file);
    cover = asUpload(form.files.cover);
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
      captchaToken?: string;
      captchaAnswer?: string;
    }>();
    title = body.title || title;
    medium = body.medium || medium;
    description = body.description || "";
    mediaUrl = ownMediaKey(body.mediaUrl || "") || "";
    color = body.color || color;
    remixable = Boolean(body.remixable);
    kind = body.kind || kind;
    license = body.license || license;
    bodyText = body.body || "";
    tools = asTools(body.tools);
    captchaToken = body.captchaToken || "";
    captchaAnswer = body.captchaAnswer || "";
  }

  const captchaError = await consumeCaptcha(captchaToken, captchaAnswer);
  if (captchaError) return c.json({ error: captchaError }, 400);

  title = clip(title, 120) || "Untitled";
  medium = clip(medium, 80) || "Digital Painting";
  description = clip(description, 500);
  bodyText = bodyText.slice(0, 20_000);
  license = clip(license, 80);
  kind = clip(kind, 20) || "image";
  color = String(color).slice(0, 32);

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
      const message = err instanceof Error ? err.message : "";
      if (/JPEG|PNG|WebP|MP3|AAC/i.test(message)) return c.json({ error: message }, 400);
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
      const message = err instanceof Error ? err.message : "";
      if (/JPEG|PNG|WebP/i.test(message)) return c.json({ error: message }, 400);
      return c.json({ error: "Could not store that cover." }, 500);
    }
  }

  let work: WorkRow;
  try {
    const inserted = await sql<WorkRow[]>`
      insert into works (
        id, artist_id, title, medium, description, media_url, color, remixable,
        download_permitted, tools, kind, license, body, cover_url
      )
      values (
        ${workId}, ${user.id}, ${title.trim()}, ${medium}, ${description || null},
        ${mediaUrl || null}, ${color}, ${remixable}, ${remixable},
        ${sql.json(tools)}, ${kind}, ${license}, ${bodyText || null},
        ${coverUrl || null}
      )
      returning *
    `;
    if (!inserted[0]) return c.json({ error: "Could not save that work." }, 500);
    work = inserted[0];
  } catch (err) {
    console.error("[works.insert]", err);
    return c.json({ error: "Could not save that work." }, 500);
  }

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
    const fail = publishFail(err);
    return c.json({ error: fail.error }, fail.status);
  }
});
