import { sql } from "../db.js";
import { newId } from "./tokens.js";

export function topicSlug(label: string) {
  return label
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

export type TopicRow = { id: string; slug: string; label: string };

export async function resolveTopic(slugOrLabel: string): Promise<TopicRow | null> {
  const slug = topicSlug(slugOrLabel);
  if (!slug) return null;
  const [aliased] = await sql<TopicRow[]>`
    select t.id, t.slug, t.label
    from topic_aliases a
    join topics t on t.id = a.topic_id
    where a.slug = ${slug}
    limit 1
  `;
  if (aliased) return aliased;
  const [topic] = await sql<TopicRow[]>`
    select id, slug, label from topics where slug = ${slug} limit 1
  `;
  return topic ?? null;
}

export async function ensureTopic(label: string): Promise<TopicRow | null> {
  const display = label.trim().slice(0, 80);
  const slug = topicSlug(display);
  if (!slug) return null;
  const existing = await resolveTopic(slug);
  if (existing) {
    await sql`
      insert into topic_aliases (slug, topic_id) values (${slug}, ${existing.id})
      on conflict do nothing
    `;
    return existing;
  }
  const id = newId("topic");
  const [topic] = await sql<TopicRow[]>`
    insert into topics (id, slug, label)
    values (${id}, ${slug}, ${display || slug})
    on conflict (slug) do update set slug = excluded.slug
    returning id, slug, label
  `;
  if (!topic) return null;
  await sql`
    insert into topic_aliases (slug, topic_id) values (${topic.slug}, ${topic.id})
    on conflict do nothing
  `;
  return topic;
}

export async function backfillTopics() {
  const works = await sql<{ id: string; medium: string }[]>`
    select id, medium from works where topic_id is null
  `;
  for (const row of works) {
    const topic = await ensureTopic(row.medium);
    if (topic) {
      await sql`update works set topic_id = ${topic.id} where id = ${row.id}`;
    }
  }

  const follows = await sql<{ user_id: string; slug: string }[]>`
    select user_id, slug from topic_follows
  `;
  for (const row of follows) {
    const topic = (await resolveTopic(row.slug)) ?? (await ensureTopic(row.slug.replace(/-/g, " ")));
    if (!topic || topic.slug === row.slug) continue;
    await sql.begin(async (tx) => {
      await tx`delete from topic_follows where user_id = ${row.user_id} and slug = ${row.slug}`;
      await tx`
        insert into topic_follows (user_id, slug)
        values (${row.user_id}, ${topic.slug})
        on conflict do nothing
      `;
    });
  }
}
