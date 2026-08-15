import { Hono } from "hono";
import { publicWork, sql, type WorkRow } from "../db.js";
import { requireAuth, type Authed } from "../lib/auth-mw.js";
import { assertUpload, isStorageReady, putWorkFile } from "../lib/storage.js";
import { newId } from "../lib/tokens.js";

export const workRoutes = new Hono<{ Variables: Authed }>();

workRoutes.get("/", async (c) => {
  const works = await sql<WorkRow[]>`
    select w.*, u.name as artist_name, u.handle as artist_handle, u.verified as artist_verified
    from works w
    join users u on u.id = w.artist_id
    order by w.created_at desc
    limit 100
  `;
  return c.json({ works: works.map(publicWork) });
});

workRoutes.get("/:id", async (c) => {
  const [work] = await sql<WorkRow[]>`
    select w.*, u.name as artist_name, u.handle as artist_handle, u.verified as artist_verified
    from works w
    join users u on u.id = w.artist_id
    where w.id = ${c.req.param("id")}
    limit 1
  `;
  if (!work) return c.json({ error: "Work not found." }, 404);
  await sql`update works set views = views + 1 where id = ${work.id}`;
  return c.json({ work: publicWork({ ...work, views: work.views + 1 }) });
});

workRoutes.post("/", requireAuth, async (c) => {
  const user = c.get("user");
  const contentType = c.req.header("content-type") || "";
  let title = "Untitled";
  let medium = "Digital Painting";
  let description = "";
  let mediaUrl = "";
  let color = "#121612";
  let remixable = false;
  let kind = "image";
  let license = "All Rights Reserved";
  let bodyText = "";
  let tools: string[] = [];
  let file: File | null = null;

  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData();
    title = String(form.get("title") || title);
    medium = String(form.get("medium") || medium);
    description = String(form.get("description") || "");
    mediaUrl = String(form.get("mediaUrl") || form.get("url") || "");
    color = String(form.get("color") || color);
    remixable = String(form.get("remixable")) === "true";
    kind = String(form.get("kind") || kind);
    license = String(form.get("license") || license);
    bodyText = String(form.get("body") || "");
    const rawTools = form.get("tools");
    if (typeof rawTools === "string" && rawTools) {
      try {
        const parsed = JSON.parse(rawTools);
        if (Array.isArray(parsed)) tools = parsed.map(String);
      } catch {
        tools = rawTools.split(",").map((t) => t.trim()).filter(Boolean);
      }
    }
    const uploaded = form.get("file");
    if (uploaded instanceof File && uploaded.size > 0) file = uploaded;
  } else {
    const body = await c.req.json<{
      title?: string;
      medium?: string;
      description?: string;
      mediaUrl?: string;
      color?: string;
      remixable?: boolean;
      kind?: string;
      license?: string;
      body?: string;
      tools?: string[];
    }>();
    title = body.title || title;
    medium = body.medium || medium;
    description = body.description || "";
    mediaUrl = body.mediaUrl || "";
    color = body.color || color;
    remixable = Boolean(body.remixable);
    kind = body.kind || kind;
    license = body.license || license;
    bodyText = body.body || "";
    if (Array.isArray(body.tools)) tools = body.tools.map(String);
  }

  const workId = newId("work");
  if (file) {
    if (!isStorageReady()) {
      return c.json({ error: "File storage is not ready yet. Add a Railway Bucket to artshare-api." }, 503);
    }
    const problem = assertUpload(file, kind);
    if (problem) return c.json({ error: problem }, 400);
    try {
      mediaUrl = await putWorkFile(user.id, workId, file, kind);
    } catch (err) {
      console.error(err);
      return c.json({ error: "Could not store that file." }, 500);
    }
  } else if ((kind === "image" || kind === "music") && !mediaUrl) {
    return c.json({ error: kind === "music" ? "Add the song before you publish." : "Add a photo before you publish." }, 400);
  }

  const [work] = await sql<WorkRow[]>`
    insert into works (
      id, artist_id, title, medium, description, media_url, color, remixable,
      download_permitted, tools, kind, license, body
    )
    values (
      ${workId}, ${user.id}, ${title.trim()}, ${medium}, ${description || null},
      ${mediaUrl || null}, ${color}, ${remixable}, ${remixable},
      ${JSON.stringify(tools)}::jsonb, ${kind}, ${license}, ${bodyText || null}
    )
    returning *
  `;

  return c.json(
    {
      work: publicWork({
        ...work,
        artist_name: user.name,
        artist_handle: user.handle,
        artist_verified: user.verified,
      }),
    },
    201,
  );
});
