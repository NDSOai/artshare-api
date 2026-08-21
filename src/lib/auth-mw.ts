import type { MiddlewareHandler } from "hono";
import { sql, type UserRow } from "../db.js";
import { env } from "../env.js";
import { readToken, tokenMatchesUser } from "./jwt.js";
import { cacheNone } from "./http-cache.js";

export type Authed = { user: UserRow };

export async function readUserFromRequest(c: { req: { header: (name: string) => string | undefined } }) {
  const header = c.req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  try {
    const payload = await readToken(token);
    const [user] = await sql<UserRow[]>`select * from users where id = ${payload.sub} limit 1`;
    if (!user || !tokenMatchesUser(payload, user)) return null;
    return user;
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
    if (!user || !tokenMatchesUser(payload, user)) return c.json({ error: "Sign in required." }, 401);
    c.set("user", user);
    await next();
    cacheNone(c);
  } catch {
    return c.json({ error: "Sign in required." }, 401);
  }
};

/** Public catalog when CATALOG_PUBLIC is on. Until then, a session is required. */
export const requireCatalog: MiddlewareHandler<{ Variables: Authed }> = async (c, next) => {
  if (env.catalogPublic) return next();
  return requireAuth(c, next);
};
