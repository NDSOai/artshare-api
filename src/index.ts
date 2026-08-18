import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { migrate } from "./db.js";
import { env } from "./env.js";
import { authRoutes } from "./routes/auth.js";
import { commentRoutes } from "./routes/comments.js";
import { followRoutes } from "./routes/follows.js";
import { messageRoutes } from "./routes/messages.js";
import { userRoutes } from "./routes/users.js";
import { isStorageReady } from "./lib/storage.js";
import { mediaRoutes } from "./routes/media.js";
import { workRoutes } from "./routes/works.js";
import { collectionRoutes } from "./routes/collections.js";
import { notificationRoutes } from "./routes/notifications.js";
import { adminRoutes } from "./routes/admin.js";
import { backfillFavoriteCollections } from "./lib/collections.js";
import { initMessageCrypto } from "./lib/crypto-message.js";
import { backfillInvitePacks } from "./lib/invites.js";
import { rekeyMessages } from "./lib/message-purge.js";
import { robotsTxt } from "./lib/ai-crawlers.js";

const app = new Hono();

const allowedOrigins = new Set(
  [
    env.frontendUrl,
    "http://localhost:3000",
    "https://www.whootaloo.com",
    "https://whootaloo.com",
    "http://127.0.0.1:3000",
    "https://artshare-frontend-production.up.railway.app",
  ].map((origin) => origin.replace(/\/$/, "")),
);

app.use("*", logger());
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
});
app.use(
  "*",
  cors({
    origin: (origin) => (origin && allowedOrigins.has(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.get("/health", (c) =>
  c.json({ ok: true, service: "artshare-api", storage: isStorageReady(), publish: "buffer" }),
);
app.get("/robots.txt", (c) =>
  c.text(robotsTxt(), 200, { "Content-Type": "text/plain; charset=utf-8" }),
);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Something went wrong on our side. Try again in a moment." }, 500);
});

app.route("/admin", adminRoutes);
app.route("/media", mediaRoutes);

app.route("/auth", authRoutes);
app.route("/users", userRoutes);
app.route("/works", commentRoutes);
app.route("/works", workRoutes);
app.route("/follows", followRoutes);
app.route("/messages", messageRoutes);
app.route("/collections", collectionRoutes);
app.route("/notifications", notificationRoutes);

app.notFound((c) => c.json({ error: "Not found." }, 404));

await migrate();
await initMessageCrypto();

serve({ fetch: app.fetch, port: env.port, overrideGlobalObjects: true }, (info) => {
  console.log(`artshare-api listening on ${info.port}`);
  void rekeyMessages()
    .then(() => backfillInvitePacks())
    .then(() => backfillFavoriteCollections());
});

