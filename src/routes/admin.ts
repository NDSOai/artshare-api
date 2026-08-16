import { Hono } from "hono";
import { sql } from "../db.js";
import { requireModerator } from "../lib/admin.js";
import { requireAuth, type Authed } from "../lib/auth-mw.js";

export const adminRoutes = new Hono<{ Variables: Authed }>();

adminRoutes.delete("/works/:id", requireAuth, requireModerator, async (c) => {
  const id = c.req.param("id");
  const [work] = await sql<{ id: string }[]>`delete from works where id = ${id} returning id`;
  if (!work) return c.json({ error: "Work not found." }, 404);
  return c.json({ deleted: "work", id: work.id });
});

adminRoutes.delete("/users/:handle", requireAuth, requireModerator, async (c) => {
  const me = c.get("user");
  const handle = c.req.param("handle").replace(/^@/, "").toLowerCase();
  if (handle === me.handle.toLowerCase()) {
    return c.json({ error: "Use account settings to delete your own account." }, 400);
  }
  const [user] = await sql<{ id: string; handle: string }[]>`
    delete from users where lower(handle) = ${handle} returning id, handle
  `;
  if (!user) return c.json({ error: "Artist not found." }, 404);
  return c.json({ deleted: "user", handle: user.handle });
});

adminRoutes.post("/reset", (c) => c.json({ error: "Not found." }, 404));
