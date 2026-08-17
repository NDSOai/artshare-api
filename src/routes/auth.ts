import { Hono } from "hono";
import { sql, publicUser, type UserRow } from "../db.js";
import { requireAuth, type Authed } from "../lib/auth-mw.js";
import { sendConfirmationEmail, sendPasswordResetEmail } from "../lib/email.js";
import { signToken } from "../lib/jwt.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { passwordProblem } from "../lib/password-policy.js";
import { generateToken, newId } from "../lib/tokens.js";
import { env } from "../env.js";
import { clientIp, hitIp, hitIpDurable, limited } from "../lib/rate-limit.js";
import { cleanHandle, signupProblem } from "../lib/signup-guard.js";
import { consumeCaptcha, issueCaptcha } from "../lib/captcha.js";
import { grantAndEmailInvites, peekOpenInvite, redeemInvite } from "../lib/invites.js";

export const authRoutes = new Hono<{ Variables: Authed }>();

authRoutes.get("/captcha", async (c) => {
  const ipLimit = hitIp(`captcha:${clientIp(c)}`, 30, 15 * 60 * 1000, "request another puzzle");
  if (ipLimit) return limited(c, ipLimit);
  return c.json(issueCaptcha());
});

authRoutes.post("/signup", async (c) => {
  const ipLimit = await hitIpDurable(`signup:${clientIp(c)}`, 3, 60 * 60 * 1000, "create another account");
  if (ipLimit) return limited(c, ipLimit);
  const body = await c.req.json<{
    email?: string;
    password?: string;
    handle?: string;
    name?: string;
    inviteCode?: string;
    captchaToken?: string;
    captchaAnswer?: string;
  }>();
  const captchaError = await consumeCaptcha(body.captchaToken || "", body.captchaAnswer || "");
  if (captchaError) return c.json({ error: captchaError }, 400);
  const email = (body.email || "").trim().toLowerCase();
  const name = (body.name || "").trim();
  const handle = cleanHandle(body.handle || "");
  const password = body.password || "";
  const inviteCode = body.inviteCode || "";
  const badPassword = passwordProblem(password);
  const badSignup = signupProblem({ email, name, handle });

  if (!email || !name || !handle || badPassword || badSignup) {
    return c.json(
      { error: badPassword || badSignup || "Name, handle, email, and a password of at least 10 characters are required." },
      400,
    );
  }

  if (env.inviteOnly && !(await peekOpenInvite(inviteCode))) {
    return c.json({ error: "That invite is not valid." }, 400);
  }

  const [takenHandle] = await sql<UserRow[]>`
    select * from users where lower(handle) = ${handle} limit 1
  `;
  if (takenHandle) return c.json({ error: "That handle is already taken." }, 409);

  const [takenEmail] = await sql<UserRow[]>`
    select * from users where lower(email) = ${email} limit 1
  `;
  if (takenEmail) {
    return c.json(
      { message: "Signup successful! Check your email to confirm your account." },
      201,
    );
  }

  const token = generateToken();
  const userId = newId("user");
  await sql`
    insert into users (id, handle, name, email, password_hash, email_verification_token, email_verification_expires_at)
    values (${userId}, ${handle}, ${name}, ${email}, ${await hashPassword(password)}, ${token}, now() + interval '48 hours')
  `;
  if (env.inviteOnly && !(await redeemInvite(inviteCode, userId))) {
    await sql`delete from users where id = ${userId}`;
    return c.json({ error: "That invite is not valid." }, 400);
  }

  const confirmationUrl = `${env.frontendUrl}/confirm-email?token=${token}`;
  try {
    await sendConfirmationEmail(email, confirmationUrl);
  } catch (err) {
    console.error("[signup] confirmation email failed", err);
  }

  return c.json(
    {
      message: "Signup successful! Check your email to confirm your account.",
    },
    201,
  );
});

authRoutes.post("/login", async (c) => {
  const ip = clientIp(c);
  const ipLimit = hitIp(`login-ip:${ip}`, 30, 15 * 60 * 1000, "try logging in");
  if (ipLimit) return limited(c, ipLimit);

  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = (body.email || "").trim().toLowerCase();
  const [user] = await sql<UserRow[]>`select * from users where lower(email) = ${email} limit 1`;
  if (!user || !(await verifyPassword(body.password || "", user.password_hash))) {
    const failLimit = hitIp(`login-fail:${email || ip}`, 8, 15 * 60 * 1000, "try logging in");
    if (failLimit) return limited(c, failLimit);
    return c.json({ error: "Could not log in." }, 401);
  }
  if (!user.email_verified_at) {
    return c.json({ error: "Confirm your email before logging in." }, 403);
  }
  return c.json({
    token: await signToken(user),
    user: publicUser(user),
  });
});

authRoutes.get("/me", requireAuth, (c) => c.json(publicUser(c.get("user"))));

authRoutes.post("/confirm-email", async (c) => {
  const ipLimit = hitIp(`confirm:${clientIp(c)}`, 20, 15 * 60 * 1000, "confirm that email");
  if (ipLimit) return limited(c, ipLimit);
  const { token } = await c.req.json<{ token?: string }>();
  if (!token) return c.json({ error: "Invalid or expired token" }, 400);
  const [user] = await sql<UserRow[]>`
    select * from users
    where email_verification_token = ${token}
      and (email_verification_expires_at is null or email_verification_expires_at > now())
    limit 1
  `;
  if (!user) return c.json({ error: "Invalid or expired token" }, 400);

  const [next] = await sql<UserRow[]>`
    update users
    set email_verified_at = now(), email_verification_token = null
    where id = ${user.id}
    returning *
  `;

  try {
    await grantAndEmailInvites(next);
  } catch (err) {
    console.error("[confirm-email] invite pack failed", err);
  }

  return c.json({
    message: "Email confirmed!",
    token: await signToken(next),
    user: publicUser(next),
  });
});

authRoutes.post("/forgot-password", async (c) => {
  const ipLimit = hitIp(`reset:${clientIp(c)}`, 5, 60 * 60 * 1000, "request another reset");
  if (ipLimit) return limited(c, ipLimit);
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
    } catch (err) {
      console.error("[forgot-password] reset email failed", err);
    }
  }
  return c.json({ message: "If that email exists, a reset link has been sent." });
});

authRoutes.post("/reset-password", async (c) => {
  const ipLimit = hitIp(`reset-use:${clientIp(c)}`, 10, 60 * 60 * 1000, "reset a password");
  if (ipLimit) return limited(c, ipLimit);
  const { token, newPassword } = await c.req.json<{ token?: string; newPassword?: string }>();
  const badPassword = passwordProblem(newPassword || "");
  if (!token || badPassword) {
    return c.json({ error: badPassword || "Invalid or expired token" }, 400);
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
    set password_hash = ${await hashPassword(newPassword || "")},
        password_reset_token = null,
        password_reset_expires_at = null,
        token_version = coalesce(token_version, 0) + 1
    where id = ${user.id}
  `;
  return c.json({ message: "Password reset successful!" });
});

authRoutes.post("/resend-confirmation", async (c) => {
  const ipLimit = hitIp(`resend:${clientIp(c)}`, 5, 60 * 60 * 1000, "request another email");
  if (ipLimit) return limited(c, ipLimit);
  const { email } = await c.req.json<{ email?: string }>();
  const clean = (email || "").trim().toLowerCase();
  if (!clean) return c.json({ error: "Email is required." }, 400);
  const [user] = await sql<UserRow[]>`select * from users where lower(email) = ${clean} limit 1`;
  if (user && !user.email_verified_at) {
    const token = user.email_verification_token || generateToken();
    await sql`
      update users
      set email_verification_token = ${token},
          email_verification_expires_at = now() + interval '48 hours'
      where id = ${user.id}
    `;
    try {
      await sendConfirmationEmail(clean, `${env.frontendUrl}/confirm-email?token=${token}`);
    } catch (err) {
      console.error("[resend-confirmation] email failed", err);
    }
  }
  return c.json({ message: "If that account still needs confirming, a new email is on its way." });
});
