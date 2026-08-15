import { Hono } from "hono";
import { sql } from "../db.js";

export const adminRoutes = new Hono();

// Reset database (delete all data but keep schema)
adminRoutes.post("/reset", async (c) => {
  const secret = c.req.query("secret");
  if (secret !== process.env.ADMIN_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    // Delete in reverse order of dependencies
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

