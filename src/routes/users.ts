import { Hono } from "hono";
import { publicArtist, publicUser, publicWork, sql, type UserRow, type WorkRow } from "../db.js";
import { requireAuth, type Authed } from "../lib/auth-mw.js";
import { isStorageReady, parseDataUrl, putAvatarFile } from "../lib/storage.js";

export const userRoutes = new Hono<{ Variables: Authed }>();

function asStringList(value: unknown, max: number) {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, max);
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
    incoming.startsWith("avatars/")
  ) {
    return incoming;
  }
  return current;
}

userRoutes.patch("/me", requireAuth, async (c) => {
  const current = c.get("user");
  try {
    const body = await c.req.json<{
      name?: string;
      bio?: string;
      photoUrl?: string;
      mediums?: string[];
      favoriteHandles?: string[];
      pinnedWorkIds?: string[];
    }>();

    const name = (body.name?.trim() || current.name).slice(0, 80);
    const bio = String(body.bio ?? current.bio ?? "").slice(0, 280);
    const mediums = asStringList(body.mediums ?? current.mediums, 3);
    const favoriteHandles = asStringList(body.favoriteHandles ?? current.favorite_handles, 5);
    const pinnedWorkIds = asStringList(body.pinnedWorkIds ?? current.pinned_work_ids, 3);
    const photoUrl = await resolvePhoto(current.id, current.photo_url, body.photoUrl);

    const [user] = await sql<UserRow[]>`
      update users set
        name = ${name},
        bio = ${bio},
        photo_url = ${photoUrl},
        mediums = ${sql.json(mediums)},
        favorite_handles = ${sql.json(favoriteHandles)},
        pinned_work_ids = ${sql.json(pinnedWorkIds)}
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
