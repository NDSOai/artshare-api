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

// Wipe the whole database. Kept off the app UI. Requires ADMIN_SECRET.
adminRoutes.post("/reset", async (c) => {
  const secret = c.req.query("secret");
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    await sql`DELETE FROM notifications`;
    await sql`DELETE FROM messages`;
    await sql`DELETE FROM comments`;
    await sql`DELETE FROM collections`;
    await sql`DELETE FROM works`;
    await sql`DELETE FROM follows`;
    await sql`DELETE FROM users`;

    return c.json({ message: "Database reset successfully" });
  } catch (err) {
    console.error("Reset failed:", err);
    return c.json({ error: "Reset failed" }, 500);
  }
});
