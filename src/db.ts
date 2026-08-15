import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { env } from "./env.js";

export const sql = postgres(env.databaseUrl, { max: 8 });

export async function migrate() {
  const file = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");
  await sql.unsafe(readFileSync(file, "utf8"));
}

export type UserRow = {
  id: string;
  handle: string;
  name: string;
  email: string;
  password_hash: string;
  bio: string;
  photo_url: string | null;
  verified: boolean;
  email_verified_at: Date | null;
  email_verification_token: string | null;
  password_reset_token: string | null;
  password_reset_expires_at: Date | null;
  mediums: string[];
  favorite_handles: string[];
  pinned_work_ids: string[];
  created_at: Date;
};

export type WorkRow = {
  id: string;
  artist_id: string;
  title: string;
  medium: string;
  description: string | null;
  media_url: string | null;
  color: string;
  remixable: boolean;
  download_permitted: boolean;
  views: number;
  tools: string[];
  created_at: Date;
  artist_name?: string;
  artist_handle?: string;
  artist_verified?: boolean;
};

export function publicUser(user: UserRow) {
  return {
    id: user.id,
    handle: user.handle,
    name: user.name,
    email: user.email,
    bio: user.bio,
    photoUrl: user.photo_url ?? undefined,
    verified: user.verified,
    mediums: user.mediums ?? [],
    favoriteHandles: user.favorite_handles ?? [],
    pinnedWorkIds: user.pinned_work_ids ?? [],
  };
}

export function publicArtist(user: UserRow) {
  return {
    name: user.name,
    handle: user.handle,
    initial: (user.name[0] ?? user.handle[0] ?? "A").toUpperCase(),
    humanVerified: user.verified,
    bio: user.bio,
    openForCommissions: false,
    skills: [],
    socialLinks: [],
    bannerColor: "#121612",
    photoUrl: user.photo_url ?? undefined,
    mediums: user.mediums ?? [],
    favoriteHandles: user.favorite_handles ?? [],
    pinnedWorkIds: user.pinned_work_ids ?? [],
  };
}

export function publicWork(work: WorkRow) {
  return {
    id: work.id,
    title: work.title,
    artist: work.artist_name ?? "",
    artistHandle: work.artist_handle ?? "",
    h: 400,
    color: work.color,
    medium: work.medium,
    humanVerified: Boolean(work.artist_verified),
    remixable: work.remixable,
    views: work.views,
    date: work.created_at.toISOString().slice(0, 10),
    tools: work.tools ?? [],
    description: work.description ?? undefined,
    downloadPermitted: work.download_permitted,
    mediaUrl: work.media_url ?? undefined,
  };
}
