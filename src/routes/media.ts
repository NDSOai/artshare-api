import { Hono } from "hono";
import { getWorkFile, isSafeMediaKey, isStorageReady } from "../lib/storage.js";

export const mediaRoutes = new Hono();

mediaRoutes.get("/*", async (c) => {
  const key = c.req.path.replace(/^\/media\/?/, "");
  if (!isStorageReady()) return c.json({ error: "File storage is not ready yet." }, 503);
  if (!key || !isSafeMediaKey(key)) return c.json({ error: "Work not found." }, 404);

  try {
    const obj = await getWorkFile(key);
    if (!obj?.Body) return c.json({ error: "Work not found." }, 404);
    const stream = obj.Body.transformToWebStream();
    return new Response(stream, {
      headers: {
        "Content-Type": obj.ContentType || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return c.json({ error: "Work not found." }, 404);
  }
});
