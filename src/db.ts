import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { env } from "./env.js";
import { publicMediaUrl } from "./lib/storage.js";

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
  banner_url: string | null;
  stripe_color: string | null;
  verified: boolean;
  email_verified_at: Date | null;
  email_verification_token: string | null;
  password_reset_token: string | null;
  password_reset_expires_at: Date | null;
  mediums: string[];
  favorite_handles: string[];
  pinned_work_ids: string[];
  social_links?: { id: string; url: string }[];
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
  kind?: string;
  license?: string;
  body?: string | null;
  cover_url?: string | null;
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
    photoUrl: publicMediaUrl(user.photo_url),
    bannerUrl: publicMediaUrl(user.banner_url),
    stripeColor: user.stripe_color || "#3A4A32",
    verified: user.verified,
    mediums: user.mediums ?? [],
    favoriteHandles: user.favorite_handles ?? [],
    pinnedWorkIds: user.pinned_work_ids ?? [],
    socialLinks: publicSocials(user.social_links),
  };
}

const SOCIAL_LABELS: Record<string, string> = {
  website: "Website",
  instagram: "Instagram",
  x: "X",
  threads: "Threads",
  bluesky: "Bluesky",
  tiktok: "TikTok",
  youtube: "YouTube",
  vimeo: "Vimeo",
  bandcamp: "Bandcamp",
  soundcloud: "SoundCloud",
  spotify: "Spotify",
  github: "GitHub",
  behance: "Behance",
  patreon: "Patreon",
};

function publicSocials(value: UserRow["social_links"]) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && SOCIAL_LABELS[item.id] && /^https?:\/\//i.test(item.url || ""))
    .slice(0, 6)
    .map((item) => ({ id: item.id, name: SOCIAL_LABELS[item.id], url: item.url }));
}

export function veilAbout<T extends { bio?: string; socialLinks?: unknown[] }>(
  artist: T,
  show: boolean,
): T & { aboutHidden: boolean } {
  const hasAbout =
    Boolean(artist.bio) || (Array.isArray(artist.socialLinks) && artist.socialLinks.length > 0);
  if (show) return { ...artist, aboutHidden: false };
  return { ...artist, bio: "", socialLinks: [], aboutHidden: hasAbout };
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
    socialLinks: publicSocials(user.social_links),
    bannerColor: "#121612",
    stripeColor: user.stripe_color || "#3A4A32",
    photoUrl: publicMediaUrl(user.photo_url),
    bannerUrl: publicMediaUrl(user.banner_url),
    mediums: user.mediums ?? [],
    favoriteHandles: user.favorite_handles ?? [],
    pinnedWorkIds: user.pinned_work_ids ?? [],
  };
}

export function publicWork(
  work: WorkRow & { reposted_by?: string | null; reposted_by_name?: string | null },
) {
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
    mediaUrl: publicMediaUrl(work.media_url),
    coverUrl: publicMediaUrl(work.cover_url),
    kind: work.kind ?? "image",
    license: work.license ?? "All Rights Reserved",
    body: work.body ?? undefined,
    repostedBy: work.reposted_by || undefined,
    repostedByName: work.reposted_by_name || undefined,
  };
}
