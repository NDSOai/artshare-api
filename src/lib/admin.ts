import type { MiddlewareHandler } from "hono";
import { env } from "../env.js";
import type { UserRow } from "../db.js";
import type { Authed } from "./auth-mw.js";

export function isAdminEmail(email?: string | null) {
  if (!email) return false;
  return env.adminEmails.includes(email.trim().toLowerCase());
}

export function canModerate(user: Pick<UserRow, "email" | "moderation_on">) {
  return isAdminEmail(user.email) && Boolean(user.moderation_on);
}

export const requireModerator: MiddlewareHandler<{ Variables: Authed }> = async (c, next) => {
  const user = c.get("user");
  if (!canModerate(user)) {
    return c.json({ error: "Moderation is off, or this account cannot moderate." }, 403);
  }
  await next();
};
