import type { Context } from "hono";
import { sql, type UserRow } from "../db.js";
import { canModerate } from "./admin.js";

export function wantsHideMature(
  c: Context,
  viewer: Pick<UserRow, "email" | "moderation_on"> | null,
) {
  const raw = (c.req.query("hideMature") || "").toLowerCase();
  if (raw !== "1" && raw !== "true") return false;
  if (viewer && canModerate(viewer)) return false;
  return true;
}

/** Callers must alias works as `w` and users as `u`. */
export function workVisibleSql(viewerId: string | null, hideMature: boolean) {
  const matureOk = hideMature
    ? viewerId
      ? sql`(not w.mature or w.artist_id = ${viewerId})`
      : sql`not w.mature`
    : sql`true`;
  const privateOk = viewerId
    ? sql`(
        not u.private_account
        or w.artist_id = ${viewerId}
        or exists (
          select 1 from follows a
          join follows b
            on b.follower_id = a.followee_id
           and b.followee_id = a.follower_id
          where a.follower_id = ${viewerId}
            and a.followee_id = w.artist_id
        )
      )`
    : sql`not u.private_account`;
  return sql`${matureOk} and ${privateOk}`;
}

export async function areMutualIds(a: string, b: string) {
  if (a === b) return true;
  const [row] = await sql<{ ok: boolean }[]>`
    select (
      exists(select 1 from follows where follower_id = ${a} and followee_id = ${b})
      and exists(select 1 from follows where follower_id = ${b} and followee_id = ${a})
    ) as ok
  `;
  return Boolean(row?.ok);
}

export async function galleryOpenTo(viewerId: string | null, artistId: string, privateAccount: boolean) {
  if (!privateAccount) return true;
  if (!viewerId) return false;
  if (viewerId === artistId) return true;
  return areMutualIds(viewerId, artistId);
}

export type WorkLock = "private" | "mature";

export async function workLockFor(opts: {
  artistId: string;
  artistPrivate: boolean;
  mature: boolean;
  viewerId: string | null;
  hideMature: boolean;
}): Promise<WorkLock | null> {
  const mine = Boolean(opts.viewerId && opts.viewerId === opts.artistId);
  if (mine) return null;
  if (opts.artistPrivate) {
    const ok = opts.viewerId ? await areMutualIds(opts.viewerId, opts.artistId) : false;
    if (!ok) return "private";
  }
  if (opts.hideMature && opts.mature) return "mature";
  return null;
}
