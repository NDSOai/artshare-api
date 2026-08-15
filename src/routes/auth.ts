import { Hono } from "hono";
import { sql, publicUser, type UserRow } from "../db.js";
import { requireAuth, type Authed } from "../lib/auth-mw.js";
import { sendConfirmationEmail, sendPasswordResetEmail } from "../lib/email.js";
import { signToken } from "../lib/jwt.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { generateToken, newId } from "../lib/tokens.js";
import { env } from "../env.js";

export const authRoutes = new Hono<{ Variables: Authed }>();

function cleanHandle(raw: string) {
  return raw.replace(/^@/, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

authRoutes.post("/signup", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string; handle?: string; name?: string }>();
  const email = (body.email || "").trim().toLowerCase();
  const name = (body.name || "").trim();
  const handle = cleanHandle(body.handle || "");
  const password = body.password || "";

  if (!email || !name || !handle || password.length < 6) {
    return c.json({ error: "Name, handle, email, and a password of at least 6 characters are required." }, 400);
  }

  const existing = await sql<UserRow[]>`
    select * from users where lower(email) = ${email} or lower(handle) = ${handle} limit 1
  `;
  if (existing[0]) return c.json({ error: "That email or handle is already taken." }, 409);

  const token = generateToken();
  const [user] = await sql<UserRow[]>`
    insert into users (id, handle, name, email, password_hash, email_verification_token)
    values (${newId("user")}, ${handle}, ${name}, ${email}, ${await hashPassword(password)}, ${token})
    returning *
  `;

  const confirmationUrl = `${env.frontendUrl}/confirm-email?token=${token}`;
  try {
    await sendConfirmationEmail(email, confirmationUrl);
    console.log(`[signup] confirmation email sent to ${email}`);
  } catch (err) {
    console.error(`[signup] failed to send confirmation email to ${email}:`, err);
  }

  return c.json(
    {
      message: "Signup successful! Check your email to confirm your account.",
      user: { id: user.id, email: user.email, handle: user.handle, name: user.name },
    },
    201,
  );
});

authRoutes.post("/login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = (body.email || "").trim().toLowerCase();
  const [user] = await sql<UserRow[]>`select * from users where lower(email) = ${email} limit 1`;
  if (!user || !(await verifyPassword(body.password || "", user.password_hash))) {
    return c.json({ error: "Could not log in." }, 401);
  }
  if (!user.email_verified_at) {
    return c.json({ error: "Confirm your email before logging in." }, 403);
  }
  return c.json({
    token: await signToken(user.id, user.handle),
    user: publicUser(user),
  });
});

authRoutes.get("/me", requireAuth, (c) => c.json(publicUser(c.get("user"))));

authRoutes.post("/confirm-email", async (c) => {
  const { token } = await c.req.json<{ token?: string }>();
  if (!token) return c.json({ error: "Invalid or expired token" }, 400);
  const [user] = await sql<UserRow[]>`
    select * from users where email_verification_token = ${token} limit 1
  `;
  if (!user) return c.json({ error: "Invalid or expired token" }, 400);

  const [next] = await sql<UserRow[]>`
    update users
    set email_verified_at = now(), email_verification_token = null, verified = true
    where id = ${user.id}
    returning *
  `;

  return c.json({
    message: "Email confirmed!",
    token: await signToken(next.id, next.handle),
    user: publicUser(next),
  });
});

authRoutes.post("/forgot-password", async (c) => {
  const { email } = await c.req.json<{ email?: string }>();
  const clean = (email || "").trim().toLowerCase();
  const [user] = await sql<UserRow[]>`select * from users where lower(email) = ${clean} limit 1`;
  if (user) {
    const token = generateToken();
    await sql`
      update users
      set password_reset_token = ${token},
          password_reset_expires_at = now() + interval '15 minutes'
      where id = ${user.id}
    `;
    try {
      await sendPasswordResetEmail(clean, `${env.frontendUrl}/reset-password?token=${token}`);
      console.log(`[forgot-password] reset email sent to ${clean}`);
    } catch (err) {
      console.error(`[forgot-password] failed to send reset email to ${clean}:`, err);
    }
  }
  return c.json({ message: "If that email exists, a reset link has been sent." });
});

authRoutes.post("/reset-password", async (c) => {
  const { token, newPassword } = await c.req.json<{ token?: string; newPassword?: string }>();
  if (!token || !newPassword || newPassword.length < 6) {
    return c.json({ error: "Invalid or expired token" }, 400);
  }
  const [user] = await sql<UserRow[]>`
    select * from users
    where password_reset_token = ${token}
      and password_reset_expires_at > now()
    limit 1
  `;
  if (!user) return c.json({ error: "Invalid or expired token" }, 400);

  await sql`
    update users
    set password_hash = ${await hashPassword(newPassword)},
        password_reset_token = null,
        password_reset_expires_at = null
    where id = ${user.id}
  `;
  return c.json({ message: "Password reset successful!" });
});

