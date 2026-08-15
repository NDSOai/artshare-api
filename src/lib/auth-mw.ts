import type { MiddlewareHandler } from "hono";
import { sql, type UserRow } from "../db.js";
import { readToken } from "./jwt.js";

export type Authed = { user: UserRow };

export async function readUserFromRequest(c: { req: { header: (name: string) => string | undefined } }) {
  const header = c.req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  try {
    const payload = await readToken(token);
    const [user] = await sql<UserRow[]>`select * from users where id = ${payload.sub} limit 1`;
    return user ?? null;
  } catch {
    return null;
  }
}

export const requireAuth: MiddlewareHandler<{ Variables: Authed }> = async (c, next) => {
  const header = c.req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return c.json({ error: "Sign in required." }, 401);
  try {
    const payload = await readToken(token);
    const [user] = await sql<UserRow[]>`select * from users where id = ${payload.sub} limit 1`;
    if (!user) return c.json({ error: "Sign in required." }, 401);
    c.set("user", user);
    await next();
  } catch {
    return c.json({ error: "Sign in required." }, 401);
  }
};
