create extension if not exists pgcrypto;

create table if not exists users (
  id text primary key,
  handle text not null unique,
  name text not null,
  email text not null unique,
  password_hash text not null,
  bio text not null default '',
  photo_url text,
  verified boolean not null default false,
  email_verified_at timestamptz,
  email_verification_token text,
  password_reset_token text,
  password_reset_expires_at timestamptz,
  mediums jsonb not null default '[]'::jsonb,
  favorite_handles jsonb not null default '[]'::jsonb,
  pinned_work_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists users_handle_lower on users (lower(handle));
create unique index if not exists users_email_lower on users (lower(email));

alter table users add column if not exists bio text not null default '';
alter table users add column if not exists photo_url text;
alter table users add column if not exists mediums jsonb not null default '[]'::jsonb;
alter table users add column if not exists favorite_handles jsonb not null default '[]'::jsonb;
alter table users add column if not exists pinned_work_ids jsonb not null default '[]'::jsonb;
alter table users add column if not exists banner_url text;
alter table users add column if not exists stripe_color text not null default '#3A4A32';
alter table users add column if not exists social_links jsonb not null default '[]'::jsonb;
alter table users add column if not exists banner_position smallint not null default 50;
alter table users add column if not exists moderation_on boolean not null default false;
alter table users add column if not exists token_version integer not null default 0;
alter table users add column if not exists email_verification_expires_at timestamptz;
alter table users add column if not exists invites_emailed_at timestamptz;

create table if not exists rate_hits (
  key text not null,
  at timestamptz not null default now()
);

create index if not exists rate_hits_key_at on rate_hits (key, at);

create table if not exists works (
  id text primary key,
  artist_id text not null references users(id) on delete cascade,
  title text not null,
  medium text not null default 'Digital Painting',
  description text,
  media_url text,
  color text not null default '#121612',
  remixable boolean not null default false,
  download_permitted boolean not null default false,
  views integer not null default 0,
  tools jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table works add column if not exists kind text not null default 'image';
alter table works add column if not exists license text not null default 'All Rights Reserved';
alter table works add column if not exists body text;
alter table works add column if not exists cover_url text;
alter table works add column if not exists pages jsonb not null default '[]'::jsonb;
alter table works add column if not exists sequence_label text;

create table if not exists comments (
  id text primary key,
  work_id text not null references works(id) on delete cascade,
  author_id text not null references users(id) on delete cascade,
  text text not null,
  pin_x double precision,
  pin_y double precision,
  created_at timestamptz not null default now()
);

alter table comments add column if not exists revisions jsonb not null default '[]'::jsonb;
alter table comments add column if not exists page_id text;

create table if not exists follows (
  follower_id text not null references users(id) on delete cascade,
  followee_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);

create table if not exists messages (
  id text primary key,
  sender_id text not null references users(id) on delete cascade,
  recipient_id text not null references users(id) on delete cascade,
  body_enc text not null,
  created_at timestamptz not null default now()
);

create index if not exists messages_pair_idx
  on messages (least(sender_id, recipient_id), greatest(sender_id, recipient_id), created_at);

create table if not exists message_reactions (
  message_id text not null references messages(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  kind text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id),
  check (kind in ('see', 'hand', 'cheer', 'sadface', 'exclaim', 'spiral', 'tree', 'being'))
);

create index if not exists message_reactions_message_idx on message_reactions (message_id);

create table if not exists likes (
  user_id text not null references users(id) on delete cascade,
  work_id text not null references works(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, work_id)
);

create table if not exists collections (
  id text primary key,
  owner_id text not null references users(id) on delete cascade,
  name text not null,
  cover_color text not null default '#121612',
  description text not null default '',
  tags jsonb not null default '[]'::jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists collection_works (
  collection_id text not null references collections(id) on delete cascade,
  work_id text not null references works(id) on delete cascade,
  created_at timestamptz not null default now(),
  sort_order integer not null default 0,
  primary key (collection_id, work_id)
);

alter table collection_works add column if not exists created_at timestamptz not null default now();
alter table collection_works add column if not exists sort_order integer not null default 0;
alter table collections add column if not exists description text not null default '';
alter table collections add column if not exists tags jsonb not null default '[]'::jsonb;
alter table collections add column if not exists sort_order integer not null default 0;
alter table collections add column if not exists cover_url text;
alter table collections add column if not exists cover_work_id text references works(id) on delete set null;

create table if not exists topic_follows (
  user_id text not null references users(id) on delete cascade,
  slug text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, slug),
  check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$')
);

create index if not exists topic_follows_slug_idx on topic_follows (slug);
alter table likes add column if not exists created_at timestamptz not null default now();

create table if not exists notifications (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  type text not null,
  from_id text references users(id) on delete set null,
  work_id text references works(id) on delete set null,
  text text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_idx on notifications (user_id, created_at desc);

create table if not exists reposts (
  user_id text not null references users(id) on delete cascade,
  work_id text not null references works(id) on delete cascade,
  caption text not null default '',
  created_at timestamptz not null default now(),
  primary key (user_id, work_id)
);

alter table reposts add column if not exists created_at timestamptz not null default now();
alter table reposts add column if not exists caption text not null default '';

create table if not exists invite_codes (
  code text primary key,
  issuer_id text not null references users(id) on delete cascade,
  redeemed_by text references users(id) on delete set null,
  redeemed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists invite_codes_issuer_idx on invite_codes (issuer_id);
create index if not exists invite_codes_open_idx on invite_codes (code) where redeemed_at is null;

create table if not exists app_kv (
  key text primary key,
  value text not null
);

alter table works add column if not exists skips integer not null default 0;

create table if not exists work_signals (
  work_id text not null references works(id) on delete cascade,
  kind text not null,
  visitor text not null,
  created_at timestamptz not null default now(),
  primary key (work_id, kind, visitor),
  check (kind in ('view', 'skip'))
);

create index if not exists work_signals_work_kind_idx on work_signals (work_id, kind);

create index if not exists works_artist_created_idx on works (artist_id, created_at desc);
create index if not exists works_created_idx on works (created_at desc);
create index if not exists works_kind_created_idx on works (kind, created_at desc);
create index if not exists likes_work_idx on likes (work_id);
create index if not exists comments_work_created_idx on comments (work_id, created_at);
create index if not exists collection_works_work_idx on collection_works (work_id);
create index if not exists follows_followee_idx on follows (followee_id, created_at desc);
create index if not exists reposts_work_idx on reposts (work_id);
create index if not exists reposts_user_created_idx on reposts (user_id, created_at desc);

create table if not exists error_events (
  id text primary key,
  code text not null unique,
  family text not null,
  message text not null,
  path text not null default '/',
  ua text not null default '',
  viewport text not null default '',
  occurred_at timestamptz not null default now(),
  handle text,
  user_id text references users(id) on delete set null,
  online boolean not null default true,
  user_reported boolean not null default false,
  note text,
  status text not null default 'open',
  count integer not null default 1,
  created_at timestamptz not null default now(),
  check (family in ('auth', 'publish', 'network', 'media', 'unexpected')),
  check (status in ('open', 'triaged', 'resolved'))
);

create index if not exists error_events_occurred_idx on error_events (occurred_at desc);
create index if not exists error_events_status_idx on error_events (status, occurred_at desc);
create index if not exists error_events_user_idx on error_events (user_id, occurred_at desc);

alter table error_events add column if not exists request_id text;
alter table error_events add column if not exists http_status integer;
alter table error_events add column if not exists route text;
create index if not exists error_events_request_idx on error_events (request_id);

alter table notifications add column if not exists error_code text;

alter table users add column if not exists private_account boolean not null default false;
alter table works add column if not exists mature boolean not null default false;
alter table works add column if not exists topic_id text;

create table if not exists topics (
  id text primary key,
  slug text not null unique,
  label text not null,
  created_at timestamptz not null default now(),
  check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$')
);

create table if not exists topic_aliases (
  slug text primary key,
  topic_id text not null references topics(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$')
);

create index if not exists topic_aliases_topic_idx on topic_aliases (topic_id);

do $$ begin
  alter table works
    add constraint works_topic_id_fkey
    foreign key (topic_id) references topics(id) on delete set null;
exception
  when duplicate_object then null;
end $$;

create index if not exists works_topic_created_idx on works (topic_id, created_at desc);
create index if not exists works_mature_created_idx on works (created_at desc) where mature = false;

create extension if not exists pg_trgm;
create index if not exists works_title_trgm on works using gin (title gin_trgm_ops);
create index if not exists works_medium_trgm on works using gin (medium gin_trgm_ops);
create index if not exists works_tools_trgm on works using gin ((tools::text) gin_trgm_ops);
