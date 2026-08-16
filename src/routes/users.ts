import { Hono } from "hono";
import { clampBannerPosition, publicArtist, publicUser, publicWork, sql, veilAbout, type UserRow, type WorkRow } from "../db.js";
import { isAdminEmail } from "../lib/admin.js";
import { readUserFromRequest, requireAuth, type Authed } from "../lib/auth-mw.js";
import { isFollowing } from "./follows.js";
import { isStorageReady, parseDataUrl, putAvatarFile, putBannerFile } from "../lib/storage.js";

export const userRoutes = new Hono<{ Variables: Authed }>();

userRoutes.get("/", async (c) => {
  const q = (c.req.query("q") || "").trim().replace(/^@+/, "");
  const users = q
    ? await sql<UserRow[]>`
        select * from users
        where handle ilike ${"%" + q + "%"} or name ilike ${"%" + q + "%"}
        order by created_at desc
        limit 40
      `
    : await sql<UserRow[]>`
        select * from users
        order by created_at desc
        limit 40
      `;
  return c.json({ users: users.map((user) => veilAbout(publicArtist(user), false)) });
});

function asStringList(value: unknown, max: number) {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, max);
}

const SOCIAL_IDS = new Set([
  "website",
  "instagram",
  "x",
  "threads",
  "bluesky",
  "tiktok",
  "youtube",
  "vimeo",
  "bandcamp",
  "soundcloud",
  "spotify",
  "github",
  "behance",
  "patreon",
]);

function asSocialLinks(value: unknown) {
  if (!Array.isArray(value)) return [];
  const out: { id: string; url: string }[] = [];
  let website = false;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as { id?: string; url?: string };
    const id = String(row.id ?? "").trim();
    const url = String(row.url ?? "").trim();
    if (!SOCIAL_IDS.has(id) || !/^https?:\/\//i.test(url)) continue;
    if (id === "website") {
      if (website) continue;
      website = true;
    } else if (out.some((link) => link.id === id)) {
      continue;
    }
    out.push({ id, url: url.slice(0, 300) });
    if (out.length >= 6) break;
  }
  return out;
}

async function resolvePhoto(userId: string, current: string | null, incoming?: string) {
  if (incoming === undefined) return current;
  if (!incoming) return null;
  if (incoming.startsWith("data:")) {
    const parsed = parseDataUrl(incoming);
    if (!parsed) throw new Error("That photo could not be used.");
    if (!isStorageReady()) return current;
    return putAvatarFile(userId, parsed);
  }
  if (
    incoming.startsWith("http://") ||
    incoming.startsWith("https://") ||
    incoming.startsWith("/media/") ||
    incoming.startsWith("avatars/") ||
    incoming.startsWith("banners/") ||
    incoming.startsWith("works/")
  ) {
    return incoming;
  }
  return current;
}

async function resolveBanner(userId: string, current: string | null, incoming?: string) {
  if (incoming === undefined) return current;
  if (!incoming) return null;
  if (incoming.startsWith("data:")) {
    const parsed = parseDataUrl(incoming);
    if (!parsed) throw new Error("That photo could not be used.");
    if (!isStorageReady()) return current;
    return putBannerFile(userId, parsed);
  }
  if (
    incoming.startsWith("http://") ||
    incoming.startsWith("https://") ||
    incoming.startsWith("/media/") ||
    incoming.startsWith("avatars/") ||
    incoming.startsWith("banners/") ||
    incoming.startsWith("works/")
  ) {
    return incoming;
  }
  return current;
}

userRoutes.delete("/me", requireAuth, async (c) => {
  const current = c.get("user");
  await sql`delete from users where id = ${current.id}`;
  return c.json({ message: "Account deleted." });
});

userRoutes.patch("/me/moderation", requireAuth, async (c) => {
  const current = c.get("user");
  if (!isAdminEmail(current.email)) {
    return c.json({ error: "This account cannot turn on moderation." }, 403);
  }
  const body = await c.req.json<{ on?: boolean }>().catch(() => ({ on: false }));
  const [user] = await sql<UserRow[]>`
    update users set moderation_on = ${Boolean(body.on)} where id = ${current.id} returning *
  `;
  return c.json(publicUser(user));
});

userRoutes.patch("/me", requireAuth, async (c) => {
  const current = c.get("user");
  try {
    const body = await c.req.json<{
      name?: string;
      bio?: string;
      photoUrl?: string;
      bannerUrl?: string;
      bannerPosition?: number;
      stripeColor?: string;
      mediums?: string[];
      favoriteHandles?: string[];
      pinnedWorkIds?: string[];
      socialLinks?: { id?: string; url?: string }[];
    }>();

    const name = (body.name?.trim() || current.name).slice(0, 80);
    const bio = String(body.bio ?? current.bio ?? "").slice(0, 280);
    const mediums = asStringList(body.mediums ?? current.mediums, 3);
    const favoriteHandles = asStringList(body.favoriteHandles ?? current.favorite_handles, 5);
    const pinnedWorkIds = asStringList(body.pinnedWorkIds ?? current.pinned_work_ids, 3);
    const socialLinks = asSocialLinks(body.socialLinks ?? current.social_links);
    const photoUrl = await resolvePhoto(current.id, current.photo_url, body.photoUrl);
    const bannerUrl = await resolveBanner(current.id, current.banner_url, body.bannerUrl);
    const bannerPosition = bannerUrl
      ? clampBannerPosition(body.bannerPosition ?? current.banner_position)
      : 50;
    const incomingStripe = typeof body.stripeColor === "string" ? body.stripeColor.trim() : "";
    const stripeColor = /^#[0-9a-fA-F]{6}$/.test(incomingStripe)
      ? incomingStripe.toUpperCase()
      : current.stripe_color || "#3A4A32";

    const [user] = await sql<UserRow[]>`
      update users set
        name = ${name},
        bio = ${bio},
        photo_url = ${photoUrl},
        banner_url = ${bannerUrl},
        banner_position = ${bannerPosition},
        stripe_color = ${stripeColor},
        mediums = ${sql.json(mediums)},
        favorite_handles = ${sql.json(favoriteHandles)},
        pinned_work_ids = ${sql.json(pinnedWorkIds)},
        social_links = ${sql.json(socialLinks)}
      where id = ${current.id}
      returning *
    `;
    if (!user) return c.json({ error: "Could not save your profile." }, 500);
    return c.json(publicUser(user));
  } catch (err) {
    console.error("[users/me]", err);
    if (err instanceof Error && err.message === "That photo could not be used.") {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: "Could not save your profile." }, 500);
  }
});

userRoutes.get("/me/cheers", requireAuth, async (c) => {
  const me = c.get("user");
  const works = await sql<WorkRow[]>`
    select w.*, u.name as artist_name, u.handle as artist_handle, u.verified as artist_verified
    from likes l
    join works w on w.id = l.work_id
    join users u on u.id = w.artist_id
    where l.user_id = ${me.id}
    order by l.created_at desc
    limit 80
  `;
  return c.json({ works: works.map(publicWork) });
});

userRoutes.get("/me/portfolio", requireAuth, async (c) => {
  const me = c.get("user");
  const [stats] = await sql<{ views: number; cheers: number; collection_adds: number }[]>`
    select
      coalesce(sum(w.views), 0)::int as views,
      (select count(*)::int from likes l join works w2 on w2.id = l.work_id where w2.artist_id = ${me.id}) as cheers,
      (select count(*)::int from collection_works cw join works w3 on w3.id = cw.work_id where w3.artist_id = ${me.id}) as collection_adds
    from works w
    where w.artist_id = ${me.id}
  `;
  const shares = await sql<
    { handle: string; name: string; work_id: string; title: string; created_at: Date }[]
  >`
    select u.handle, u.name, w.id as work_id, w.title, r.created_at
    from reposts r
    join works w on w.id = r.work_id
    join users u on u.id = r.user_id
    where w.artist_id = ${me.id}
    order by r.created_at desc
    limit 40
  `;
  const collections = await sql<
    { handle: string; name: string; work_id: string; title: string; collection: string; created_at: Date }[]
  >`
    select u.handle, u.name, w.id as work_id, w.title, c.name as collection, cw.created_at
    from collection_works cw
    join collections c on c.id = cw.collection_id
    join works w on w.id = cw.work_id
    join users u on u.id = c.owner_id
    where w.artist_id = ${me.id}
    order by cw.created_at desc
    limit 40
  `;
  return c.json({
    views: stats?.views ?? 0,
    cheers: stats?.cheers ?? 0,
    collectionAdds: stats?.collection_adds ?? 0,
    shares: shares.map((row) => ({
      handle: row.handle,
      name: row.name,
      workId: row.work_id,
      workTitle: row.title,
      at: row.created_at.toISOString(),
    })),
    collections: collections.map((row) => ({
      handle: row.handle,
      name: row.name,
      workId: row.work_id,
      workTitle: row.title,
      collectionName: row.collection,
      at: row.created_at.toISOString(),
    })),
  });
});

userRoutes.get("/:handle", async (c) => {
  const handle = c.req.param("handle").toLowerCase();
  const [user] = await sql<UserRow[]>`select * from users where lower(handle) = ${handle} limit 1`;
  if (!user) return c.json({ error: "Artist not found." }, 404);
  const works = await sql<WorkRow[]>`
    select w.*, u.name as artist_name, u.handle as artist_handle, u.verified as artist_verified
    from works w
    join users u on u.id = w.artist_id
    where w.artist_id = ${user.id}
    order by w.created_at desc
  `;
  const reposts = await sql<(WorkRow & { reposted_by: string; reposted_by_name: string; repost_caption: string })[]>`
    select w.*, u.name as artist_name, u.handle as artist_handle, u.verified as artist_verified,
           ${user.handle} as reposted_by, ${user.name} as reposted_by_name, r.caption as repost_caption
    from reposts r
    join works w on w.id = r.work_id
    join users u on u.id = w.artist_id
    where r.user_id = ${user.id}
    order by r.created_at desc
  `;
  const me = await readUserFromRequest(c);
  const showAbout = Boolean(me && (me.id === user.id || (await isFollowing(me.id, user.id))));
  return c.json({
    user: showAbout && me?.id === user.id ? publicUser(user) : undefined,
    artist: veilAbout(publicArtist(user), showAbout),
    works: works.map(publicWork),
    reposts: reposts.map(publicWork),
  });
});
