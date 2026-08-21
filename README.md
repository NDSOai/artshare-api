# artshare-api

Hono API for **Whootaloo**. This is the backend. The frontend is [`NDSOai/whootaloo`](https://github.com/NDSOai/whootaloo).

The old Railway Function source was not in GitHub, so this repo rebuilds the API from the frontend contract plus the auth/email routes Railway already specified. Passwords are hashed. Message bodies are encrypted at rest.

## Run locally

```bash
cp .env.example .env
# set DATABASE_URL, JWT_SECRET, MESSAGE_SECRET
npm install
npm run dev
```

Needs Postgres. Railway can provide `DATABASE_URL`.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres |
| `JWT_SECRET` | yes | Session tokens |
| `MESSAGE_SECRET` | yes | Chat encryption at rest. Keep in Railway env. Do not store in the database. |
| `MESSAGE_SECRET_PREV` | no | Comma-separated old secrets, only if you rotate |
| `FRONTEND_URL` | yes in prod | Confirm / reset links, CORS |
| `RESEND_API_KEY` | for mail | Without it, links log to stdout in local only |
| `RESEND_FROM` | no | Defaults to Resend onboarding sender |
| `BUCKET_ENDPOINT` | for files | Railway Bucket `ENDPOINT` |
| `BUCKET_NAME` | for files | Railway Bucket `BUCKET` |
| `BUCKET_ACCESS_KEY_ID` | for files | Railway Bucket `ACCESS_KEY_ID` |
| `BUCKET_SECRET_ACCESS_KEY` | for files | Railway Bucket `SECRET_ACCESS_KEY` |
| `BUCKET_REGION` | no | Defaults to `auto` |
| `API_PUBLIC_URL` | for files | Public API origin, used in media URLs |
| `INVITE_ONLY` | no | Defaults on. Signup needs an invite |
| `CATALOG_PUBLIC` | no | Defaults off. Flip on with the site opening so Wander/search work without a session |
| `PORT` | no | Railway sets this |

## Routes

Matches `lib/api.ts` on the frontend.

| Method | Path |
|---|---|
| POST | `/auth/signup` |
| POST | `/auth/login` |
| POST | `/auth/logout` |
| POST | `/auth/change-password` |
| GET | `/auth/me` |
| POST | `/auth/confirm-email` |
| POST | `/auth/forgot-password` |
| POST | `/auth/reset-password` |
| GET | `/users/:handle` |
| PATCH | `/users/me` |
| GET/POST | `/works` |
| GET | `/media/*` |
| GET | `/works/:id` |
| GET/POST | `/works/:id/comments` |
| GET/POST/DELETE | `/follows/:handle` |
| GET | `/messages` |
| GET/POST | `/messages/:handle` |

Signup does not return a session. Confirm email first. Chat requires a mutual follow.

Messages use AES-256-GCM on the server with `MESSAGE_SECRET` from the environment. This is encryption at rest, not end-to-end. An older key may still sit in Postgres `app_kv` so existing threads can be read and rewritten onto the env secret.

## Point Railway at this repo

I cannot change the Railway service from here. In the Railway dashboard:

1. Open the **artshare-api** service
2. **Settings → Source**
3. Disconnect the Function / empty source
4. Connect **GitHub → NDSOai/artshare-api → `main`**
5. Root directory: `/` (this repo is the API)
6. Keep or add variables: `DATABASE_URL`, `JWT_SECRET`, `MESSAGE_SECRET`, `FRONTEND_URL`, `RESEND_API_KEY`
7. Set `JWT_SECRET` and `MESSAGE_SECRET` once. Do not generate new values on later deploys.
8. Deploy

Then set `NEXT_PUBLIC_API_URL` on the frontend service to this API’s public domain.
