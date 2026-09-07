import { Hono, type Context } from "hono";
import { asPublicWork, publicWorks, recordWorkSignal, sql, type WorkRow } from "../db.js";
import { readUserFromRequest, requireAuth, requireCatalog, type Authed } from "../lib/auth-mw.js";
import { notify } from "../lib/notify.js";
import { assertCooldown, clientIp, hitIp, lastRepostAt, lastWorkAt, limited, limitPublicGet, repostsLastHour } from "../lib/rate-limit.js";
import { parseMultipart, type FormFile } from "../lib/multipart.js";
import { assertUpload, isStorageReady, ownMediaKey, putWorkFile, putWorkPageFile } from "../lib/storage.js";
import { consumeCaptcha } from "../lib/captcha.js";
import { newId } from "../lib/tokens.js";
import { cacheNone, cacheCatalog } from "../lib/http-cache.js";
import { ensureTopic, topicSlug } from "../lib/topics.js";
import { wantsHideMature, workLockFor, workVisibleSql } from "../lib/visibility.js";
import { coverKeyFromPages, firstImageMediaKey } from "../lib/work-cover.js";

export const workRoutes = new Hono<{ Variables: Authed }>();

function clip(value: string, max: number) {
  return value.trim().slice(0, max);
}

async function visitorOf(c: Context) {
  const me = await readUserFromRequest(c);
  if (me) return `u:${me.id}`;
  return `ip:${clientIp(c)}`;
}

const WORK_LIST_SELECT = sql`
  w.*, u.name as artist_name, u.handle as artist_handle, u.verified as artist_verified,
  u.private_account as artist_private, t.slug as topic_slug
`;

function kindFilterSql(kind: string) {
  if (!kind || kind === "all") return sql`true`;
  return sql`w.kind = ${kind}`;
}

function mediumFilterSql(medium: string) {
  const raw = medium.trim();
  if (!raw) return sql`true`;
  const slug = topicSlug(raw);
  const legacy = raw.toLowerCase().replace(/\s+/g, "-");
  return sql`(
    t.slug = ${slug}
    or exists (
      select 1 from topic_aliases a
      where a.topic_id = w.topic_id and a.slug = ${slug}
    )
    or lower(regexp_replace(btrim(w.medium), E'\\s+', '-', 'g')) = ${legacy}
  )`;
}

function searchFilterSql(q: string) {
  const needle = q.trim();
  if (!needle) return sql`true`;
  const like = `%${needle}%`;
  return sql`(
    w.title ilike ${like}
    or u.name ilike ${like}
    or u.handle ilike ${like}
    or w.medium ilike ${like}
    or w.tools::text ilike ${like}
    or coalesce(w.sequence_label, '') ilike ${like}
  )`;
}

function followingFilterSql(userId: string) {
  return sql`(
    w.artist_id = ${userId}
    or w.artist_id in (select followee_id from follows where follower_id = ${userId})
    or exists (
      select 1
      from topic_follows tf
      left join topic_aliases a on a.slug = tf.slug
      left join topics tp on tp.slug = tf.slug
      where tf.user_id = ${userId}
        and w.topic_id is not null
        and w.topic_id = coalesce(a.topic_id, tp.id)
    )
    or lower(regexp_replace(btrim(w.medium), E'\\s+', '-', 'g')) in (
      select slug from topic_follows where user_id = ${userId}
    )
  )`;
}

function followedTopicBoostSql(userId: string | null) {
  if (!userId) return sql`0`;
  return sql`(
    case when exists (
      select 1
      from topic_follows tf
      left join topic_aliases a on a.slug = tf.slug
      left join topics tp on tp.slug = tf.slug
      where tf.user_id = ${userId}
        and w.topic_id is not null
        and w.topic_id = coalesce(a.topic_id, tp.id)
    ) then 2.0 else 0 end
  )`;
}

function parseCursor(raw: string) {
  const value = raw.trim();
  if (!value) return null;
  const split = value.lastIndexOf("|");
  if (split <= 0) return null;
  const at = new Date(value.slice(0, split));
  const id = value.slice(split + 1).trim();
  if (!id || !Number.isFinite(at.getTime())) return null;
  return { at: at.toISOString(), id };
}

function cursorSql(cursor: { at: string; id: string } | null) {
  if (!cursor) return sql`true`;
  return sql`(w.created_at, w.id) < (${cursor.at}::timestamptz, ${cursor.id})`;
}

function excludeSql(ids: string[]) {
  if (!ids.length) return sql`true`;
  return sql`w.id not in ${sql(ids)}`;
}

function parseExclude(raw: string) {
  return [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))].slice(0, 80);
}

function asBoolFlag(value: unknown) {
  if (value === true || value === false) return value;
  const raw = String(value ?? "").toLowerCase();
  return raw === "true" || raw === "1";
}

workRoutes.get("/", requireCatalog, async (c) => {
  const blocked = limitPublicGet(c, "works-list", 120);
  if (blocked) return blocked;
  const q = (c.req.query("q") || "").trim().replace(/[%_]/g, "").slice(0, 80);
  const medium = (c.req.query("medium") || "").trim();
  const kind = (c.req.query("kind") || "").trim();
  const following = c.req.query("following") === "1";
  const wander = c.req.query("mode") === "wander";
  const me = await readUserFromRequest(c);
  if (following && !me) return c.json({ works: [], nextCursor: null });

  const hideMature = wantsHideMature(c, me);
  const visible = workVisibleSql(me?.id ?? null, hideMature);
  const kindSql = kindFilterSql(kind);
  const mediumSql = mediumFilterSql(medium);
  const searchSql = searchFilterSql(q);
  const exclude = parseExclude(c.req.query("exclude") || "");
  const cursor = parseCursor(c.req.query("cursor") || "");
  const pageSize = wander ? 24 : 40;

  cacheNone(c);

  if (wander) {
    const boost = followedTopicBoostSql(me?.id ?? null);
    const rows = await sql<WorkRow[]>`
      select ${WORK_LIST_SELECT},
        (
          ${boost}
          + ln(1 + coalesce((select count(*)::int from likes l where l.work_id = w.id), 0)) * 0.55
          - ln(1 + coalesce(w.skips, 0)) * 0.75
          + random() * 1.4
          + exp(-extract(epoch from (now() - w.created_at)) / 86400.0 / 40.0) * 0.4
        ) as wander_score
      from works w
      join users u on u.id = w.artist_id
      left join topics t on t.id = w.topic_id
      where ${visible}
        and ${kindSql}
        and ${mediumSql}
        and ${excludeSql(exclude)}
      order by wander_score desc, w.created_at desc, w.id desc
      limit ${pageSize}
    `;
    return c.json({ works: await publicWorks(rows), nextCursor: rows.length === pageSize ? "more" : null });
  }

  if (following && me) {
    const followSql = followingFilterSql(me.id);
    const originals = await sql<WorkRow[]>`
      select ${WORK_LIST_SELECT}
      from works w
      join users u on u.id = w.artist_id
      left join topics t on t.id = w.topic_id
      where ${followSql}
        and ${visible}
        and ${mediumSql}
        and ${kindSql}
        and ${cursorSql(cursor)}
      order by w.created_at desc, w.id desc
      limit ${pageSize + 1}
    `;
    const boosted =
      cursor
        ? []
        : await sql<(WorkRow & { reposted_by: string; reposted_by_name: string; repost_caption: string })[]>`
      select ${WORK_LIST_SELECT},
             ru.handle as reposted_by, ru.name as reposted_by_name, r.caption as repost_caption
      from reposts r
      join works w on w.id = r.work_id
      join users u on u.id = w.artist_id
      join users ru on ru.id = r.user_id
      left join topics t on t.id = w.topic_id
      where r.user_id in (select followee_id from follows where follower_id = ${me.id})
        and w.artist_id <> r.user_id
        and ${visible}
        and ${mediumSql}
        and ${kindSql}
      order by r.created_at desc
      limit ${pageSize}
    `;
    const overflow = originals.length > pageSize;
    const originalPage = overflow ? originals.slice(0, pageSize) : originals;
    const seen = new Set<string>();
    const page = [...boosted, ...originalPage].filter((work) => {
      if (seen.has(work.id)) return false;
      seen.add(work.id);
      return true;
    });
    const last = originalPage[originalPage.length - 1];
    const nextCursor = overflow && last ? `${new Date(last.created_at).toISOString()}|${last.id}` : null;
    return c.json({ works: await publicWorks(page), nextCursor });
  }

  const works = await sql<WorkRow[]>`
    select ${WORK_LIST_SELECT}
    from works w
    join users u on u.id = w.artist_id
    left join topics t on t.id = w.topic_id
    where ${searchSql}
      and ${visible}
      and ${mediumSql}
      and ${kindSql}
      and ${cursorSql(cursor)}
    order by w.created_at desc, w.id desc
    limit ${pageSize + 1}
  `;
  const overflow = works.length > pageSize;
  const page = overflow ? works.slice(0, pageSize) : works;
  const last = page[page.length - 1];
  const nextCursor = overflow && last ? `${new Date(last.created_at).toISOString()}|${last.id}` : null;
  return c.json({ works: await publicWorks(page), nextCursor });
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

workRoutes.post("/:id/signal", async (c) => {
  const blocked = hitIp(`work-signal:${clientIp(c)}`, 90, 60_000, "try");
  if (blocked) return limited(c, blocked);
  const workId = c.req.param("id");
  const body = await c.req.json<{ kind?: string }>().catch(() => ({} as { kind?: string }));
  const kind = body.kind === "skip" ? "skip" : body.kind === "view" ? "view" : null;
  if (!kind) return c.json({ error: "Unknown signal." }, 400);
  const [work] = await sql<{ id: string }[]>`select id from works where id = ${workId} limit 1`;
  if (!work) return c.json({ error: "Work not found." }, 404);
  const added = await recordWorkSignal(work.id, kind, await visitorOf(c));
  return c.json({ ok: true, added });
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

  try {
    const contentType = c.req.header("content-type") || "";
    const useForm = contentType.includes("multipart/form-data");

    let title = existing.title;
    let medium = existing.medium;
    let description = existing.description ?? "";
    let color = existing.color;
    let remixable = existing.remixable;
    let kind = existing.kind ?? "image";
    let license = existing.license ?? "All Rights Reserved";
    let bodyText = existing.body ?? "";
    let tools = existing.tools ?? [];
    let mediaUrl = existing.media_url ?? "";
    let coverUrl = existing.cover_url ?? "";
    let pagesRaw: unknown = undefined;
    let sequenceLabelRaw: string | undefined;
    let mature = Boolean(existing.mature);
    let coverPageId = "";
    let file: FormFile | null = null;
    let cover: FormFile | null = null;
    let formFiles: Record<string, FormFile> = {};

    if (useForm) {
      const form = await readForm(c, MAX_SEQUENCE_BYTES);
      if (form.fields.title !== undefined) title = String(form.fields.title);
      if (form.fields.medium !== undefined) medium = String(form.fields.medium);
      if (form.fields.description !== undefined) description = String(form.fields.description);
      if (form.fields.color !== undefined) color = String(form.fields.color);
      if (form.fields.remixable !== undefined) remixable = String(form.fields.remixable) === "true";
      if (form.fields.mature !== undefined) mature = asBoolFlag(form.fields.mature);
      if (form.fields.kind !== undefined) kind = String(form.fields.kind);
      if (form.fields.license !== undefined) license = String(form.fields.license);
      if (form.fields.body !== undefined) bodyText = String(form.fields.body);
      if (form.fields.tools !== undefined) tools = asTools(form.fields.tools);
      if (form.fields.pages !== undefined) pagesRaw = form.fields.pages;
      if (form.fields.sequenceLabel !== undefined) sequenceLabelRaw = String(form.fields.sequenceLabel);
      if (form.fields.coverPageId !== undefined) coverPageId = String(form.fields.coverPageId);
      file = asUpload(form.files.file);
      cover = asUpload(form.files.cover);
      formFiles = form.files;
    } else {
      const body = await c.req.json<{
        title?: string;
        medium?: string;
        description?: string;
        color?: string;
        remixable?: boolean;
        kind?: string;
        license?: string;
        body?: string;
        tools?: string[];
        pages?: unknown;
        sequenceLabel?: string;
        mature?: boolean;
        coverPageId?: string;
      }>().catch(() => ({} as Record<string, never>));
      if (body.title !== undefined) title = String(body.title);
      if (body.medium !== undefined) medium = String(body.medium);
      if (body.description !== undefined) description = String(body.description);
      if (body.color !== undefined) color = String(body.color);
      if (body.remixable !== undefined) remixable = Boolean(body.remixable);
      if (body.mature !== undefined) mature = Boolean(body.mature);
      if (body.kind !== undefined) kind = String(body.kind);
      if (body.license !== undefined) license = String(body.license);
      if (body.body !== undefined) bodyText = String(body.body);
      if (body.tools !== undefined) tools = asTools(body.tools);
      if (body.pages !== undefined) pagesRaw = body.pages;
      if (body.sequenceLabel !== undefined) sequenceLabelRaw = String(body.sequenceLabel);
      if (body.coverPageId !== undefined) coverPageId = String(body.coverPageId);
    }

    title = clip(title, 120) || existing.title;
    medium = clip(medium, 80) || existing.medium;
    description = clip(description, 500);
    bodyText = bodyText.slice(0, 20_000);
    license = clip(license, 80);
    kind = clip(kind, 20) || existing.kind || "image";
    color = String(color).slice(0, 32);

    const existingPages = storedPages(existing.pages);
    let pages = existingPages;
    let sequenceLabel = existing.sequence_label ?? null;

    if (pagesRaw !== undefined) {
      const incoming = parsePagesInput(pagesRaw);
      if (!incoming) return c.json({ error: "Pages must be a JSON array." }, 400);
      const built = await buildStoredPages({
        userId: user.id,
        workId: existing.id,
        pages: incoming,
        files: formFiles,
        topFile: file,
        topCover: cover,
        existing: existingPages,
        requireMedia: false,
      });
      if ("error" in built) return c.json({ error: built.error }, 400);
      pages = built.pages;
    } else if (file || cover) {
      if (!isStorageReady()) {
        return c.json({ error: "File storage is not ready yet. Add a Railway Bucket to artshare-api." }, 503);
      }
      const uploadKind = kind === "sequence" ? (existingPages[0]?.kind ?? "image") : kind;
      if (file) {
        const problem = assertUpload(file, uploadKind === "text" ? "image" : uploadKind);
        if (problem) return c.json({ error: problem }, 400);
        try {
          mediaUrl = await putWorkFile(user.id, existing.id, file, uploadKind === "text" ? "image" : uploadKind);
        } catch (err) {
          console.error(err);
          const message = err instanceof Error ? err.message : "";
          if (/JPEG|PNG|WebP|MP3|M4A|AAC/i.test(message)) return c.json({ error: message }, 400);
          return c.json({ error: "Could not store that file." }, 500);
        }
      }
      if (cover) {
        const problem = assertUpload(cover, "image");
        if (problem) return c.json({ error: problem }, 400);
        try {
          coverUrl = await putWorkFile(user.id, `${existing.id}-cover`, cover, "image");
        } catch (err) {
          console.error(err);
          const message = err instanceof Error ? err.message : "";
          if (/JPEG|PNG|WebP/i.test(message)) return c.json({ error: message }, 400);
          return c.json({ error: "Could not store that cover." }, 500);
        }
      }
      if (existingPages.length) {
        pages = existingPages.map((page, index) =>
          index === 0
            ? {
                ...page,
                mediaUrl: file ? mediaUrl || page.mediaUrl : page.mediaUrl,
                coverUrl: cover ? coverUrl || page.coverUrl : page.coverUrl,
              }
            : page,
        );
      }
    }

    if (pages.length > 1) {
      kind = "sequence";
      const label =
        sequenceLabelRaw !== undefined
          ? clip(sequenceLabelRaw, 80)
          : clip(existing.sequence_label ?? "", 80);
      if (!label) return c.json({ error: "Pick a sequence label before you save." }, 400);
      sequenceLabel = label;
    } else if (pagesRaw !== undefined) {
      kind = pages[0]?.kind ?? kind;
      sequenceLabel = null;
      if (sequenceLabelRaw !== undefined && !pages.length) sequenceLabel = null;
    } else if (sequenceLabelRaw !== undefined) {
      sequenceLabel = clip(sequenceLabelRaw, 80) || null;
    }

    if (pages.length) {
      const first = pages[0];
      mediaUrl = first.mediaUrl ?? "";
      if (coverPageId) {
        const picked = coverKeyFromPages(pages, coverPageId);
        if (picked) coverUrl = picked;
      } else if (!coverUrl) {
        coverUrl = firstImageMediaKey(pages) || first.coverUrl || coverUrl;
      }
      if (first.kind === "text") bodyText = first.body ?? bodyText;
      else if (pagesRaw !== undefined) bodyText = first.body ?? "";
    }

    const topic = await ensureTopic(medium);
    const [work] = await sql<WorkRow[]>`
      update works set
        title = ${title},
        medium = ${medium},
        description = ${description || null},
        color = ${color},
        remixable = ${remixable},
        download_permitted = ${remixable},
        tools = ${sql.json(tools)},
        kind = ${kind},
        license = ${license},
        body = ${bodyText || null},
        media_url = ${mediaUrl || null},
        cover_url = ${coverUrl || null},
        pages = ${sql.json(pages)},
        sequence_label = ${sequenceLabel},
        mature = ${mature},
        topic_id = ${topic?.id ?? null}
      where id = ${existing.id}
      returning *
    `;
    if (!work) return c.json({ error: "Could not save that work." }, 500);
    return c.json({
      work: await asPublicWork({
        ...work,
        artist_name: user.name,
        artist_handle: user.handle,
        artist_verified: user.verified,
      }),
    });
  } catch (err) {
    console.error("[works.update]", err);
    const fail = publishFail(err);
    return c.json({ error: fail.error }, fail.status);
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

workRoutes.get("/:id", requireCatalog, async (c) => {
  const blocked = limitPublicGet(c, "works-get", 120);
  if (blocked) return blocked;
  const viewer = await readUserFromRequest(c);
  const hideMature = wantsHideMature(c, viewer);
  const [work] = await sql<WorkRow[]>`
    select w.*, u.name as artist_name, u.handle as artist_handle, u.verified as artist_verified,
           u.private_account as artist_private, t.slug as topic_slug
    from works w
    join users u on u.id = w.artist_id
    left join topics t on t.id = w.topic_id
    where w.id = ${c.req.param("id")}
    limit 1
  `;
  if (!work) return c.json({ error: "Work not found." }, 404);
  const lock = await workLockFor({
    artistId: work.artist_id,
    artistPrivate: Boolean(work.artist_private),
    mature: Boolean(work.mature),
    viewerId: viewer?.id ?? null,
    hideMature,
  });
  if (lock) {
    cacheNone(c);
    return c.json({
      work: await asPublicWork({ ...work, locked: lock }),
      shares: [],
    });
  }
  await sql`update works set views = views + 1 where id = ${work.id}`;
  await recordWorkSignal(work.id, "view", await visitorOf(c), false);
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
  const [collects] = await sql<{ n: number }[]>`
    select count(*)::int as n from collection_works where work_id = ${work.id}
  `;
  cacheNone(c);
  return c.json({
    work: await asPublicWork({
      ...work,
      views: work.views + 1,
      share_count: count?.n ?? shares.length,
      collect_count: collects?.n ?? 0,
    }),
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
const MAX_SEQUENCE_BYTES = 100 * 1024 * 1024;

type PageKind = "image" | "text" | "music";

type PageInput = {
  id: string;
  kind: PageKind;
  body?: string;
  h?: number;
  w?: number;
};

type StoredPage = {
  id: string;
  kind: PageKind;
  body?: string;
  mediaUrl?: string;
  coverUrl?: string;
  h?: number;
  w?: number;
};

function asPageKind(value: unknown): PageKind | null {
  const kind = String(value ?? "");
  if (kind === "image" || kind === "text" || kind === "music") return kind;
  return null;
}

function parsePagesInput(raw: unknown): PageInput[] | null {
  let value = raw;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value)) return null;
  const out: PageInput[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const kind = asPageKind(row.kind);
    if (!kind) continue;
    const h = row.h != null ? Number(row.h) : NaN;
    const w = row.w != null ? Number(row.w) : NaN;
    out.push({
      id: clip(String(row.id || `page-${index + 1}`), 80) || `page-${index + 1}`,
      kind,
      body: row.body != null ? String(row.body).slice(0, 20_000) : undefined,
      h: Number.isFinite(h) ? h : undefined,
      w: Number.isFinite(w) ? w : undefined,
    });
  }
  return out.slice(0, 40);
}

function storedPages(raw: unknown): StoredPage[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredPage[] = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const kind = asPageKind(row.kind);
    if (!kind) continue;
    const h = row.h != null ? Number(row.h) : NaN;
    const w = row.w != null ? Number(row.w) : NaN;
    const media =
      ownMediaKey(String(row.mediaUrl ?? row.media_url ?? "")) ||
      (typeof row.mediaUrl === "string" && isSafeStorageKey(row.mediaUrl) ? row.mediaUrl : "") ||
      (typeof row.media_url === "string" && isSafeStorageKey(row.media_url) ? row.media_url : "");
    const cover =
      ownMediaKey(String(row.coverUrl ?? row.cover_url ?? "")) ||
      (typeof row.coverUrl === "string" && isSafeStorageKey(row.coverUrl) ? row.coverUrl : "") ||
      (typeof row.cover_url === "string" && isSafeStorageKey(row.cover_url) ? row.cover_url : "");
    out.push({
      id: String(row.id || `page-${index + 1}`),
      kind,
      body: row.body != null && String(row.body) ? String(row.body).slice(0, 20_000) : undefined,
      mediaUrl: media || undefined,
      coverUrl: cover || undefined,
      h: Number.isFinite(h) ? h : undefined,
      w: Number.isFinite(w) ? w : undefined,
    });
  }
  return out;
}

function isSafeStorageKey(value: string) {
  return /^(works|avatars|banners|collections)\/[a-zA-Z0-9._/-]+$/.test(value) && !value.includes("..");
}

function pageUpload(
  files: Record<string, FormFile>,
  index: number,
  topFile: FormFile | null,
  topCover: FormFile | null,
) {
  return {
    media: asUpload(files[`page${index}`]) ?? (index === 0 ? topFile : null),
    cover: asUpload(files[`page${index}Cover`]) ?? (index === 0 ? topCover : null),
  };
}

async function buildStoredPages(opts: {
  userId: string;
  workId: string;
  pages: PageInput[];
  files: Record<string, FormFile>;
  topFile: FormFile | null;
  topCover: FormFile | null;
  existing?: StoredPage[];
  requireMedia: boolean;
}): Promise<{ pages: StoredPage[] } | { error: string }> {
  const { userId, workId, pages, files, topFile, topCover, existing = [], requireMedia } = opts;
  if (!pages.length) return { pages: [] };

  const needsUpload = pages.some((page, index) => {
    const upload = pageUpload(files, index, topFile, topCover);
    return Boolean(upload.media || upload.cover);
  });
  if (needsUpload && !isStorageReady()) {
    return { error: "File storage is not ready yet. Add a Railway Bucket to artshare-api." };
  }

  const out: StoredPage[] = [];
  for (const [index, page] of pages.entries()) {
    const prev = existing.find((item) => item.id === page.id) ?? existing[index];
    const upload = pageUpload(files, index, topFile, topCover);
    let mediaUrl = prev?.mediaUrl;
    let coverUrl = prev?.coverUrl;
    const body = page.kind === "text" ? (page.body ?? "").trim() : page.body?.trim() || undefined;

    if (page.kind === "text") {
      if (!body && requireMedia) return { error: "Write each text page before you publish." };
      if (!body && !prev?.body) return { error: "Write each text page before you publish." };
    } else if (upload.media) {
      const problem = assertUpload(upload.media, page.kind);
      if (problem) return { error: problem };
      try {
        mediaUrl = await putWorkPageFile(userId, workId, index, upload.media, page.kind);
      } catch (err) {
        console.error(err);
        const message = err instanceof Error ? err.message : "";
        if (/JPEG|PNG|WebP|MP3|M4A|AAC/i.test(message)) return { error: message };
        return { error: "Could not store that file." };
      }
    } else if (requireMedia && !mediaUrl) {
      return {
        error: page.kind === "music" ? "Add the song before you publish." : "Add a photo before you publish.",
      };
    }

    if (upload.cover && page.kind !== "image") {
      const problem = assertUpload(upload.cover, "image");
      if (problem) return { error: problem };
      try {
        coverUrl = await putWorkPageFile(userId, workId, index, upload.cover, "image", true);
      } catch (err) {
        console.error(err);
        const message = err instanceof Error ? err.message : "";
        if (/JPEG|PNG|WebP/i.test(message)) return { error: message };
        return { error: "Could not store that cover." };
      }
    }

    out.push({
      id: page.id,
      kind: page.kind,
      body: page.kind === "text" ? body || prev?.body : body,
      mediaUrl,
      coverUrl: page.kind === "image" ? undefined : coverUrl,
      h: page.h ?? prev?.h,
      w: page.w ?? prev?.w,
    });
  }
  return { pages: out };
}

async function readForm(
  c: {
    req: {
      header: (name: string) => string | undefined;
      arrayBuffer: () => Promise<ArrayBuffer>;
    };
  },
  maxBytes = MAX_PUBLISH_BYTES,
) {
  const length = Number(c.req.header("content-length") || 0);
  if (length > maxBytes) {
    throw new Error("That file is too large.");
  }
  const type = c.req.header("content-type") || "";
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (buf.byteLength > maxBytes) {
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
  const raw = (() => {
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
  })();
  return raw
    .map((item) => {
      const t = item.trim();
      if (t.startsWith("gear:")) return t.slice(0, 160);
      return t.slice(0, 32);
    })
    .filter(Boolean)
    .slice(0, 20);
}

workRoutes.post("/", requireAuth, async (c) => {
  const user = c.get("user");
  try {
  const tooSoon = await assertCooldown(await lastWorkAt(user.id), 20 * 60 * 1000, "publish");
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
  let mature = false;
  let kind = "image";
  let license = "All Rights Reserved";
  let bodyText = "";
  let tools: string[] = [];
  let file: FormFile | null = null;
  let cover: FormFile | null = null;
  let coverUrl = "";
  let pagesRaw: unknown = undefined;
  let sequenceLabelRaw = "";
  let coverPageId = "";
  let formFiles: Record<string, FormFile> = {};

  const useForm = contentType.includes("multipart/form-data") || !contentType.includes("json");
  if (useForm) {
    const form = await readForm(c, MAX_SEQUENCE_BYTES);
    title = String(form.fields.title || title);
    medium = String(form.fields.medium || medium);
    description = String(form.fields.description || "");
    mediaUrl = ownMediaKey(String(form.fields.mediaUrl || form.fields.url || "")) || "";
    color = String(form.fields.color || color);
    remixable = String(form.fields.remixable) === "true";
    mature = asBoolFlag(form.fields.mature);
    kind = String(form.fields.kind || kind);
    license = String(form.fields.license || license);
    bodyText = String(form.fields.body || "");
    tools = asTools(form.fields.tools);
    captchaToken = String(form.fields.captchaToken || "");
    captchaAnswer = String(form.fields.captchaAnswer || "");
    pagesRaw = form.fields.pages;
    sequenceLabelRaw = String(form.fields.sequenceLabel || "");
    coverPageId = String(form.fields.coverPageId || "");
    file = asUpload(form.files.file);
    cover = asUpload(form.files.cover);
    formFiles = form.files;
  } else {
    const body = await c.req.json<{
      title?: string;
      medium?: string;
      description?: string;
      mediaUrl?: string;
      color?: string;
      remixable?: boolean;
      mature?: boolean;
      kind?: string;
      license?: string;
      body?: string;
      tools?: string[];
      pages?: unknown;
      sequenceLabel?: string;
      coverPageId?: string;
      captchaToken?: string;
      captchaAnswer?: string;
    }>();
    title = body.title || title;
    medium = body.medium || medium;
    description = body.description || "";
    mediaUrl = ownMediaKey(body.mediaUrl || "") || "";
    color = body.color || color;
    remixable = Boolean(body.remixable);
    mature = Boolean(body.mature);
    kind = body.kind || kind;
    license = body.license || license;
    bodyText = body.body || "";
    tools = asTools(body.tools);
    pagesRaw = body.pages;
    sequenceLabelRaw = String(body.sequenceLabel || "");
    coverPageId = String(body.coverPageId || "");
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
  const pageInputs = pagesRaw !== undefined ? parsePagesInput(pagesRaw) : [];
  if (pagesRaw !== undefined && pageInputs === null) {
    return c.json({ error: "Pages must be a JSON array." }, 400);
  }

  let pages: StoredPage[] = [];
  let sequenceLabel: string | null = null;

  if (pageInputs && pageInputs.length > 0) {
    if (pageInputs.length > 1) {
      kind = "sequence";
      sequenceLabel = clip(sequenceLabelRaw, 80);
      if (!sequenceLabel) {
        return c.json({ error: "Pick a sequence label before you publish." }, 400);
      }
    } else {
      kind = pageInputs[0].kind;
    }

    const built = await buildStoredPages({
      userId: user.id,
      workId,
      pages: pageInputs,
      files: formFiles,
      topFile: file,
      topCover: cover,
      requireMedia: true,
    });
    if ("error" in built) return c.json({ error: built.error }, 400);
    pages = built.pages;
    const first = pages[0];
    mediaUrl = first?.mediaUrl ?? "";
    coverUrl = coverKeyFromPages(pages, coverPageId) || first?.coverUrl || "";
    bodyText = first?.kind === "text" ? first.body ?? "" : first?.body ?? bodyText;
  } else {
    if (kind === "sequence") {
      return c.json({ error: "Add at least two pages before you publish a sequence." }, 400);
    }
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
        if (/JPEG|PNG|WebP|MP3|M4A|AAC/i.test(message)) return c.json({ error: message }, 400);
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
  }

  let work: WorkRow;
  try {
    const topic = await ensureTopic(medium);
    const inserted = await sql<WorkRow[]>`
      insert into works (
        id, artist_id, title, medium, description, media_url, color, remixable,
        download_permitted, tools, kind, license, body, cover_url, pages, sequence_label,
        mature, topic_id
      )
      values (
        ${workId}, ${user.id}, ${title.trim()}, ${medium}, ${description || null},
        ${mediaUrl || null}, ${color}, ${remixable}, ${remixable},
        ${sql.json(tools)}, ${kind}, ${license}, ${bodyText || null},
        ${coverUrl || null}, ${sql.json(pages)}, ${sequenceLabel},
        ${mature}, ${topic?.id ?? null}
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
      work: await asPublicWork({
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
