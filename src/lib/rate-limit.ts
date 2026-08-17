import type { Context } from "hono";
import { sql } from "../db.js";
import { isAiCrawler } from "./ai-crawlers.js";

const ipHits = new Map<string, number[]>();

export function clientIp(c: Context) {
  const real = c.req.header("x-real-ip") || c.req.header("cf-connecting-ip") || "";
  if (real.trim()) return real.trim();
  const forwarded = c.req.header("x-forwarded-for") || "";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

export function waitMessage(waitMs: number, action: string) {
  if (waitMs <= 45_000) return `Wait a few seconds before you ${action} again.`;
  const mins = Math.ceil(waitMs / 60_000);
  if (mins <= 1) return `Wait a minute before you ${action} again.`;
  return `You can ${action} again in ${mins} minutes.`;
}

export function hitIp(ip: string, max: number, windowMs: number, action: string) {
  const now = Date.now();
  const times = (ipHits.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (times.length >= max) {
    const wait = windowMs - (now - times[0]);
    return { error: waitMessage(wait, action), retryAfter: Math.ceil(wait / 1000) };
  }
  times.push(now);
  ipHits.set(ip, times);
  return null;
}

export async function hitIpDurable(key: string, max: number, windowMs: number, action: string) {
  const since = new Date(Date.now() - windowMs);
  await sql`delete from rate_hits where at < now() - interval '2 days'`;
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from rate_hits
    where key = ${key} and at > ${since}
  `;
  if ((row?.n ?? 0) >= max) {
    const [oldest] = await sql<{ at: Date }[]>`
      select at from rate_hits
      where key = ${key} and at > ${since}
      order by at asc
      limit 1
    `;
    const wait = oldest
      ? windowMs - (Date.now() - new Date(oldest.at).getTime())
      : windowMs;
    return { error: waitMessage(Math.max(wait, 1000), action), retryAfter: Math.ceil(Math.max(wait, 1000) / 1000) };
  }
  await sql`insert into rate_hits (key) values (${key})`;
  return null;
}

export async function assertCooldown(
  last: Date | null | undefined,
  gapMs: number,
  action: string,
) {
  if (!last) return null;
  const at = last instanceof Date ? last.getTime() : new Date(String(last)).getTime();
  if (!Number.isFinite(at)) return null;
  const wait = gapMs - (Date.now() - at);
  if (wait <= 0) return null;
  return { error: waitMessage(wait, action), retryAfter: Math.ceil(wait / 1000) };
}

export async function lastWorkAt(userId: string) {
  const [row] = await sql<{ created_at: Date }[]>`
    select created_at from works where artist_id = ${userId} order by created_at desc limit 1
  `;
  return row?.created_at ?? null;
}

export async function lastCommentAt(userId: string) {
  const [row] = await sql<{ created_at: Date }[]>`
    select created_at from comments where author_id = ${userId} order by created_at desc limit 1
  `;
  return row?.created_at ?? null;
}

export async function commentsLastHour(userId: string) {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from comments
    where author_id = ${userId} and created_at > now() - interval '1 hour'
  `;
  return row?.n ?? 0;
}

export async function lastMessageAt(userId: string) {
  const [row] = await sql<{ created_at: Date }[]>`
    select created_at from messages where sender_id = ${userId} order by created_at desc limit 1
  `;
  return row?.created_at ?? null;
}

export async function messagesLastHour(userId: string) {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from messages
    where sender_id = ${userId} and created_at > now() - interval '1 hour'
  `;
  return row?.n ?? 0;
}

export async function followsLastHour(userId: string) {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from follows
    where follower_id = ${userId} and created_at > now() - interval '1 hour'
  `;
  return row?.n ?? 0;
}

export async function lastRepostAt(userId: string) {
  const [row] = await sql<{ created_at: Date }[]>`
    select created_at from reposts where user_id = ${userId} order by created_at desc limit 1
  `;
  return row?.created_at ?? null;
}

export async function repostsLastHour(userId: string) {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from reposts
    where user_id = ${userId} and created_at > now() - interval '1 hour'
  `;
  return row?.n ?? 0;
}

export function limited(c: Context, err: { error: string; retryAfter: number }) {
  c.header("Retry-After", String(err.retryAfter));
  return c.json({ error: err.error }, 429);
}

/** Generous IP cap plus a hard no for known training crawlers. Memory only, so images stay fast. */
export function limitPublicGet(c: Context, bucket: string, max: number, windowMs = 60_000) {
  const ua = c.req.header("user-agent") || "";
  if (isAiCrawler(ua)) {
    return c.json({ error: "Automated copying of works is not allowed." }, 403);
  }
  const err = hitIp(`${bucket}:${clientIp(c)}`, max, windowMs, "try");
  if (err) return limited(c, err);
  return null;
}
