/** Still used for sequence thumbs, banners, and collection covers. */

function pageId(row: Record<string, unknown>) {
  return String(row.id ?? "").trim();
}

function pageKind(row: Record<string, unknown>) {
  return String(row.kind ?? "").trim();
}

function pageMedia(row: Record<string, unknown>) {
  return String(row.mediaUrl ?? row.media_url ?? "").trim();
}

export function firstImageMediaKey(pages: unknown): string | null {
  if (!Array.isArray(pages)) return null;
  for (const item of pages) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (pageKind(row) !== "image") continue;
    const url = pageMedia(row);
    if (url) return url;
  }
  return null;
}

export function coverKeyFromPages(pages: unknown, coverPageId?: string | null): string | null {
  const wanted = (coverPageId || "").trim();
  if (wanted && Array.isArray(pages)) {
    for (const item of pages) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (pageId(row) !== wanted) continue;
      if (pageKind(row) !== "image") break;
      const url = pageMedia(row);
      if (url) return url;
      break;
    }
  }
  return firstImageMediaKey(pages);
}

export function workStillKey(work: {
  kind?: string | null;
  media_url?: string | null;
  cover_url?: string | null;
  pages?: unknown;
}): string | null {
  const kind = work.kind ?? "image";
  if (kind === "music" || kind === "text") {
    return work.cover_url || firstImageMediaKey(work.pages) || work.media_url || null;
  }
  if (kind === "sequence") {
    return work.cover_url || firstImageMediaKey(work.pages) || null;
  }
  return work.media_url || work.cover_url || firstImageMediaKey(work.pages) || null;
}
