import { Hono } from "hono";
import { publicArtist, publicUser, publicWork, sql, type UserRow, type WorkRow } from "../db.js";
import { requireAuth, type Authed } from "../lib/auth-mw.js";

export const userRoutes = new Hono<{ Variables: Authed }>();

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
  return c.json({
    user: publicUser(user),
    artist: publicArtist(user),
    works: works.map(publicWork),
  });
});

userRoutes.patch("/me", requireAuth, async (c) => {
  const current = c.get("user");
  const body = await c.req.json<{
    name?: string;
    bio?: string;
    photoUrl?: string;
    mediums?: string[];
    favoriteHandles?: string[];
    pinnedWorkIds?: string[];
  }>();

  const [user] = await sql<UserRow[]>`
    update users set
      name = ${body.name?.trim() || current.name},
      bio = ${body.bio ?? current.bio},
      photo_url = ${body.photoUrl ?? current.photo_url},
      mediums = ${JSON.stringify(body.mediums ?? current.mediums)}::jsonb,
      favorite_handles = ${JSON.stringify(body.favoriteHandles ?? current.favorite_handles)}::jsonb,
      pinned_work_ids = ${JSON.stringify(body.pinnedWorkIds ?? current.pinned_work_ids)}::jsonb
    where id = ${current.id}
    returning *
  `;
  return c.json(publicUser(user));
});
