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
