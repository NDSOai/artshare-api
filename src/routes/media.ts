import type { Context } from "hono";
import { Hono } from "hono";
import { getWorkFile, headWorkFile, isSafeMediaKey, isStorageReady } from "../lib/storage.js";
import { limitPublicGet } from "../lib/rate-limit.js";

export const mediaRoutes = new Hono();

function mediaHeaders(extra: Record<string, string> = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noai, noimageai",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Accept-Ranges": "bytes",
    ...extra,
  };
}

/**
 * Safari on iPhone requires byte-range (206) responses for <audio>/<video>.
 * Streaming a bare 200 without Accept-Ranges works in Firefox/Chrome but fails on iOS WebKit.
 */
async function serveMedia(c: Context) {
  const blocked = limitPublicGet(c, "media", 600);
  if (blocked) return blocked;
  const key = c.req.path.replace(/^\/media\/?/, "");
  if (!isStorageReady()) return c.json({ error: "File storage is not ready yet." }, 503);
  if (!key || !isSafeMediaKey(key)) return c.json({ error: "Work not found." }, 404);

  const method = c.req.method.toUpperCase();
  const range = c.req.header("range") || undefined;

  try {
    if (method === "HEAD" && !range) {
      const head = await headWorkFile(key);
      if (!head) return c.json({ error: "Work not found." }, 404);
      const type = head.ContentType || "application/octet-stream";
      const length = head.ContentLength != null ? String(head.ContentLength) : undefined;
      return new Response(null, {
        status: 200,
        headers: mediaHeaders({
          "Content-Type": type,
          ...(length ? { "Content-Length": length } : {}),
        }),
      });
    }

    const obj = await getWorkFile(key, range && /^bytes=/i.test(range) ? range : undefined);
    if (!obj?.Body) return c.json({ error: "Work not found." }, 404);

    const type = obj.ContentType || "application/octet-stream";
    const partial = Boolean(range && obj.ContentRange);
    const headers = mediaHeaders({
      "Content-Type": type,
      ...(obj.ContentLength != null ? { "Content-Length": String(obj.ContentLength) } : {}),
      ...(obj.ContentRange ? { "Content-Range": obj.ContentRange } : {}),
    });

    if (method === "HEAD") {
      return new Response(null, { status: partial ? 206 : 200, headers });
    }

    const stream = obj.Body.transformToWebStream();
    return new Response(stream, { status: partial ? 206 : 200, headers });
  } catch {
    return c.json({ error: "Work not found." }, 404);
  }
}

mediaRoutes.on(["GET", "HEAD"], "/*", (c) => serveMedia(c));
