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

create table if not exists comments (
  id text primary key,
  work_id text not null references works(id) on delete cascade,
  author_id text not null references users(id) on delete cascade,
  text text not null,
  pin_x double precision,
  pin_y double precision,
  created_at timestamptz not null default now()
);

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
