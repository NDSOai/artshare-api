import type { Context } from "hono";
import { env } from "../env.js";

export function cachePublic(c: Context, maxAge: number, swr = maxAge * 2) {
  c.header("Cache-Control", `public, max-age=${maxAge}, stale-while-revalidate=${swr}`);
}

export function cacheNone(c: Context) {
  c.header("Cache-Control", "no-store");
}

export function cacheCatalog(c: Context, maxAge: number, swr = maxAge * 2) {
  if (env.catalogPublic) cachePublic(c, maxAge, swr);
  else cacheNone(c);
}
