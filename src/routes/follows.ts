import { Hono } from "hono";
import { sql, type UserRow } from "../db.js";
import { requireAuth, type Authed } from "../lib/auth-mw.js";
import { notify } from "../lib/notify.js";
import { followsLastHour, limited } from "../lib/rate-limit.js";

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
  return c.json({ following: true, mutual: await areMutual(me.id, them.id) });
});

followRoutes.delete("/:handle", requireAuth, async (c) => {
  const me = c.get("user");
  const them = await findUser(c.req.param("handle"));
  if (!them) return c.json({ error: "Artist not found." }, 404);
  await sql`delete from follows where follower_id = ${me.id} and followee_id = ${them.id}`;
  return c.json({ following: false, mutual: false });
});
