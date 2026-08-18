import type { Context } from "hono";

export function cachePublic(c: Context, maxAge: number, swr = maxAge * 2) {
  c.header("Cache-Control", `public, max-age=${maxAge}, stale-while-revalidate=${swr}`);
}

export function cacheNone(c: Context) {
  c.header("Cache-Control", "no-store");
}
