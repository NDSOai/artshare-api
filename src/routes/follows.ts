import { Hono } from "hono";
import { sql, type UserRow } from "../db.js";
import { requireAuth, type Authed } from "../lib/auth-mw.js";
import { notify } from "../lib/notify.js";
import { followsLastHour, limited } from "../lib/rate-limit.js";
import { publicMediaUrl } from "../lib/storage.js";

export const followRoutes = new Hono<{ Variables: Authed }>();

async function findUser(handle: string) {
  const [user] = await sql<UserRow[]>`select * from users where lower(handle) = ${handle.toLowerCase()} limit 1`;
  return user ?? null;
}

export async function isFollowing(followerId: string, followeeId: string) {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from follows
    where follower_id = ${followerId} and followee_id = ${followeeId}
  `;
  return row.n > 0;
}

export async function areMutual(a: string, b: string) {
  const [row] = await sql<{ ok: boolean }[]>`
    select (
      exists(select 1 from follows where follower_id = ${a} and followee_id = ${b})
      and exists(select 1 from follows where follower_id = ${b} and followee_id = ${a})
    ) as ok
  `;
  return Boolean(row?.ok);
}

followRoutes.get("/", requireAuth, async (c) => {
  const me = c.get("user");
  const following = await sql<{ handle: string }[]>`
    select u.handle from follows f
    join users u on u.id = f.followee_id
    where f.follower_id = ${me.id}
    order by f.created_at desc
  `;
  const followers = await sql<{ handle: string }[]>`
    select u.handle from follows f
    join users u on u.id = f.follower_id
    where f.followee_id = ${me.id}
    order by f.created_at desc
  `;
  const topics = await sql<{ slug: string }[]>`
    select slug from topic_follows where user_id = ${me.id} order by created_at desc
  `;
  return c.json({
    following: following.map((row) => row.handle),
    followers: followers.map((row) => row.handle),
    topics: topics.map((row) => row.slug),
  });
});

followRoutes.get("/hometree", requireAuth, async (c) => {
  const me = c.get("user");
  const rows = await sql<
    {
      handle: string;
      name: string;
      photo_url: string | null;
      verified: boolean;
      last_posted_at: Date | null;
    }[]
  >`
    select
      u.handle,
      u.name,
      u.photo_url,
      u.verified,
      (select max(w.created_at) from works w where w.artist_id = u.id) as last_posted_at
    from follows f
    join users u on u.id = f.follower_id
    where f.followee_id = ${me.id}
    order by last_posted_at desc nulls last, lower(u.handle) asc
  `;
  return c.json({
    people: rows.map((row) => ({
      handle: row.handle,
      name: row.name,
      photoUrl: publicMediaUrl(row.photo_url),
      verified: row.verified,
      lastPostedAt: row.last_posted_at ? row.last_posted_at.toISOString() : null,
    })),
  });
});

function asTopicSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 63);
}

followRoutes.put("/topics", requireAuth, async (c) => {
  const me = c.get("user");
  const body = await c.req.json<{ topics?: string[] }>().catch(() => ({ topics: [] as string[] }));
  const wanted = [...new Set((Array.isArray(body.topics) ? body.topics : []).map(asTopicSlug).filter(Boolean))];
  await sql.begin(async (tx) => {
    await tx`delete from topic_follows where user_id = ${me.id}`;
    for (const slug of wanted) {
      await tx`insert into topic_follows (user_id, slug) values (${me.id}, ${slug}) on conflict do nothing`;
    }
  });
  return c.json({ topics: wanted });
});

followRoutes.post("/topics/:slug", requireAuth, async (c) => {
  const me = c.get("user");
  const slug = asTopicSlug(c.req.param("slug"));
  if (!slug) return c.json({ error: "That topic could not be followed." }, 400);
  await sql`
    insert into topic_follows (user_id, slug)
    values (${me.id}, ${slug})
    on conflict do nothing
  `;
  return c.json({ following: true, slug });
});

followRoutes.delete("/topics/:slug", requireAuth, async (c) => {
  const me = c.get("user");
  const slug = asTopicSlug(c.req.param("slug"));
  if (slug) {
    await sql`delete from topic_follows where user_id = ${me.id} and slug = ${slug}`;
  }
  return c.json({ following: false, slug });
});

followRoutes.get("/:handle", requireAuth, async (c) => {
  const me = c.get("user");
  const them = await findUser(c.req.param("handle"));
  if (!them) return c.json({ error: "Artist not found." }, 404);
  const [mine] = await sql<{ n: number }[]>`
    select count(*)::int as n from follows where follower_id = ${me.id} and followee_id = ${them.id}
  `;
  const [theirs] = await sql<{ n: number }[]>`
    select count(*)::int as n from follows where follower_id = ${them.id} and followee_id = ${me.id}
  `;
  return c.json({
    following: mine.n > 0,
    followedBy: theirs.n > 0,
    mutual: mine.n > 0 && theirs.n > 0,
  });
});

followRoutes.post("/:handle", requireAuth, async (c) => {
  const me = c.get("user");
  const them = await findUser(c.req.param("handle"));
  if (!them) return c.json({ error: "Artist not found." }, 404);
  if (them.id === me.id) return c.json({ error: "You cannot follow yourself." }, 400);
  if ((await followsLastHour(me.id)) >= 30) {
    return limited(c, { error: "You can follow more people in a bit.", retryAfter: 3600 });
  }
  const inserted = await sql<{ follower_id: string }[]>`
    insert into follows (follower_id, followee_id)
    values (${me.id}, ${them.id})
    on conflict do nothing
    returning follower_id
  `;
  if (inserted[0]) {
    await notify({
      userId: them.id,
      fromId: me.id,
      type: "follow",
      text: "followed you",
    });
  }
  const followedBy = await isFollowing(them.id, me.id);
  return c.json({ following: true, followedBy, mutual: followedBy });
});

followRoutes.delete("/:handle", requireAuth, async (c) => {
  const me = c.get("user");
  const them = await findUser(c.req.param("handle"));
  if (!them) return c.json({ error: "Artist not found." }, 404);
  await sql`delete from follows where follower_id = ${me.id} and followee_id = ${them.id}`;
  return c.json({ following: false, mutual: false });
});
