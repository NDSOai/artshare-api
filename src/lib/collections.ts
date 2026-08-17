import { sql } from "../db.js";
import { newId } from "./tokens.js";

export const FAVORITES_NAME = "Favorites";

export function isFavoritesName(name: string) {
  return name.trim().toLowerCase() === "favorites";
}

export async function ensureFavorites(ownerId: string) {
  const [existing] = await sql<{ id: string }[]>`
    select id from collections
    where owner_id = ${ownerId} and lower(name) = 'favorites'
    limit 1
  `;
  if (existing) return existing.id;
  const [row] = await sql<{ id: string }[]>`
    insert into collections (id, owner_id, name)
    values (${newId("col")}, ${ownerId}, ${FAVORITES_NAME})
    returning id
  `;
  return row.id;
}

export async function backfillFavoriteCollections() {
  const missing = await sql<{ id: string }[]>`
    select u.id
    from users u
    where not exists (
      select 1 from collections c
      where c.owner_id = u.id and lower(c.name) = 'favorites'
    )
  `;
  for (const user of missing) {
    await ensureFavorites(user.id);
  }
  if (missing.length) {
    console.log(`[collections] seeded Favorites for ${missing.length} accounts`);
  }
}
