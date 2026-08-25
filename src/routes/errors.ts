import { Hono } from "hono";
import { sql } from "../db.js";
import { requireAdmin } from "../lib/admin.js";
import { readUserFromRequest, requireAuth, type Authed } from "../lib/auth-mw.js";
import { notify } from "../lib/notify.js";
import { clientIp, hitIpDurable, limited } from "../lib/rate-limit.js";
import { newId } from "../lib/tokens.js";
import { parseHttpStatus, parseRequestId, parseRoute } from "../lib/request-id.js";

export const errorRoutes = new Hono<{ Variables: Authed }>();

const FAMILIES = new Set(["auth", "publish", "network", "media", "unexpected"]);
const STATUSES = new Set(["open", "triaged", "resolved"]);
const CODE = /^WTL-[A-HJ-NP-Z2-9]{4}$/i;
const SECRET = /(token|password|secret|authorization|cookie|bearer)/i;

type ErrorRow = {
  id: string;
  code: string;
  family: string;
  message: string;
  path: string;
  ua: string;
  viewport: string;
  occurred_at: Date;
  handle: string | null;
  user_id: string | null;
  online: boolean;
  user_reported: boolean;
  note: string | null;
  status: string;
  count: number;
  request_id: string | null;
  http_status: number | null;
  route: string | null;
};

function clip(value: unknown, max: number) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  if (text.startsWith("data:")) return "[redacted media]";
  const cut = text.slice(0, max);
  return SECRET.test(cut) ? `${cut.slice(0, 80)}…` : cut;
}

function publicError(row: ErrorRow) {
  return {
    id: row.id,
    code: row.code,
    family: row.family,
    message: row.message,
    path: row.path,
    ua: row.ua,
    viewport: row.viewport,
    occurredAt: new Date(row.occurred_at).toISOString(),
    handle: row.handle || undefined,
    online: row.online,
    userReported: row.user_reported,
    note: row.note || undefined,
    status: row.status,
    count: row.count,
    requestId: row.request_id || undefined,
    httpStatus: row.http_status ?? undefined,
    route: row.route || undefined,
  };
}

function familyOf(value: unknown) {
  const family = typeof value === "string" ? value.trim().toLowerCase() : "";
  return FAMILIES.has(family) ? family : "unexpected";
}

async function findByCode(code: string) {
  const key = code.trim().replace(/^#/, "").toUpperCase();
  const [row] = await sql<ErrorRow[]>`select * from error_events where code = ${key} limit 1`;
  return row ?? null;
}

errorRoutes.post("/", async (c) => {
  const ipLimit = await hitIpDurable(`error-create:${clientIp(c)}`, 40, 60 * 60 * 1000, "report that again");
  if (ipLimit) return limited(c, ipLimit);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const code = String(body.code ?? "")
    .trim()
    .replace(/^#/, "")
    .toUpperCase();
  if (!CODE.test(code)) return c.json({ error: "That error code is not valid." }, 400);

  const user = await readUserFromRequest(c);
  const message = clip(body.message, 280) || "Something went wrong on our side.";
  const path = clip(String(body.path ?? "").split("?")[0], 180) || "/";
  const ua = clip(body.ua, 280);
  const viewport = clip(body.viewport, 32);
  const family = familyOf(body.family);
  const requestId = parseRequestId(body.requestId) || null;
  const httpStatus = parseHttpStatus(body.httpStatus);
  const route = parseRoute(body.route) || null;
  const occurredRaw = typeof body.occurredAt === "string" ? Date.parse(body.occurredAt) : NaN;
  const occurredAt = Number.isFinite(occurredRaw) ? new Date(occurredRaw) : new Date();

  const alert = body.alert !== false;
  const existing = await findByCode(code);
  if (existing) {
    const [row] = await sql<ErrorRow[]>`
      update error_events
      set count = count + 1,
          occurred_at = ${occurredAt},
          message = ${message},
          path = ${path},
          request_id = coalesce(${requestId}, request_id),
          http_status = coalesce(${httpStatus}, http_status),
          route = coalesce(${route}, route)
      where code = ${existing.code}
      returning *
    `;
    return c.json({ error: publicError(row ?? existing) });
  }

  const [row] = await sql<ErrorRow[]>`
    insert into error_events (
      id, code, family, message, path, ua, viewport, occurred_at, handle, user_id,
      request_id, http_status, route
    )
    values (
      ${newId("err")},
      ${code},
      ${family},
      ${message},
      ${path},
      ${ua},
      ${viewport},
      ${occurredAt},
      ${user?.handle ?? null},
      ${user?.id ?? null},
      ${requestId},
      ${httpStatus},
      ${route}
    )
    returning *
  `;

  if (
    user &&
    alert &&
    family !== "network" &&
    httpStatus != null &&
    httpStatus !== 502 &&
    httpStatus !== 503 &&
    httpStatus !== 504
  ) {
    await notify({
      userId: user.id,
      type: "error",
      errorCode: code,
      text: `Error code: #${code}`,
    });
  }

  return c.json({ error: publicError(row!) }, 201);
});

errorRoutes.post("/:code/report", async (c) => {
  const ipLimit = await hitIpDurable(`error-report:${clientIp(c)}`, 20, 60 * 60 * 1000, "send that report");
  if (ipLimit) return limited(c, ipLimit);

  const key = String(c.req.param("code") ?? "")
    .trim()
    .replace(/^#/, "")
    .toUpperCase();
  if (!CODE.test(key)) return c.json({ error: "That error code is not valid." }, 400);

  const user = await readUserFromRequest(c);
  const body = (await c.req.json().catch(() => ({}))) as { note?: unknown };
  const note = clip(body.note, 1000);
  const existing = await findByCode(key);

  const [row] = existing
    ? await sql<ErrorRow[]>`
        update error_events
        set user_reported = true, note = ${note || existing.note}
        where code = ${existing.code}
        returning *
      `
    : await sql<ErrorRow[]>`
        insert into error_events (
          id, code, family, message, path, ua, viewport, occurred_at, handle, user_id,
          user_reported, note
        )
        values (
          ${newId("err")},
          ${key},
          'unexpected',
          'Reported from a device that no longer has the original event.',
          '/',
          '',
          '',
          ${new Date()},
          ${user?.handle ?? null},
          ${user?.id ?? null},
          true,
          ${note || null}
        )
        returning *
      `;

  if (user) {
    await sql`
      delete from notifications
      where user_id = ${user.id}
        and type = 'error'
        and replace(upper(coalesce(error_code, '')), '#', '') = ${key}
    `;
  }

  if (!row) return c.json({ error: "Could not save that report." }, 500);
  return c.json({ error: publicError(row) });
});

errorRoutes.get("/", requireAuth, requireAdmin, async (c) => {
  const status = String(c.req.query("status") ?? "")
    .trim()
    .toLowerCase();
  const reported = String(c.req.query("reported") ?? "")
    .trim()
    .toLowerCase();
  const rows = await sql<ErrorRow[]>`
    select * from error_events
    order by occurred_at desc
    limit 200
  `;
  const filtered = rows.filter((row) => {
    if (STATUSES.has(status) && row.status !== status) return false;
    if (["1", "true", "yes"].includes(reported) && !row.user_reported) return false;
    if (["0", "false", "no"].includes(reported) && row.user_reported) return false;
    return true;
  });
  return c.json({ errors: filtered.map(publicError) });
});

errorRoutes.get("/:code", async (c) => {
  const row = await findByCode(c.req.param("code"));
  if (!row) return c.json({ error: "That error code was not found." }, 404);
  return c.json({ error: publicError(row) });
});

errorRoutes.patch("/:code", requireAuth, requireAdmin, async (c) => {
  const existing = await findByCode(c.req.param("code"));
  if (!existing) return c.json({ error: "That error code was not found." }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { status?: unknown };
  const status = typeof body.status === "string" ? body.status.trim().toLowerCase() : "";
  if (!STATUSES.has(status)) return c.json({ error: "That status is not valid." }, 400);
  const [row] = await sql<ErrorRow[]>`
    update error_events set status = ${status} where code = ${existing.code} returning *
  `;
  return c.json({ error: publicError(row ?? { ...existing, status }) });
});
