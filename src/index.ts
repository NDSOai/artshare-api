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

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: [env.frontendUrl, "http://localhost:3000"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

app.get("/health", (c) => c.json({ ok: true, service: "artshare-api", storage: isStorageReady() }));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Something went wrong on our side. Try again in a moment." }, 500);
});

app.route("/media", mediaRoutes);

app.route("/auth", authRoutes);
app.route("/users", userRoutes);
app.route("/works", commentRoutes);
app.route("/works", workRoutes);
app.route("/follows", followRoutes);
app.route("/messages", messageRoutes);

app.notFound((c) => c.json({ error: "Not found." }, 404));

await migrate();

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`artshare-api listening on ${info.port}`);
});
