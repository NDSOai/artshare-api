import { Resend } from "resend";
import { env } from "../env.js";

function client() {
  if (!env.resendApiKey) return null;
  return new Resend(env.resendApiKey);
}

function wrap(title: string, body: string, href: string, label: string) {
  return `
    <div style="font-family: 'Quicksand', sans-serif; background: #060806; color: #E6E6E2; padding: 40px; text-align: center;">
      <h1 style="color: #C4A84A;">${title}</h1>
      <p>${body}</p>
      <a href="${href}" style="display: inline-block; background: #C4A84A; color: #060806; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold; margin: 20px 0;">
        ${label}
      </a>
      <p style="color: #7A827A; font-size: 12px; margin-top: 20px;">Or copy this link: ${href}</p>
    </div>
  `;
}

export async function sendConfirmationEmail(email: string, confirmationUrl: string) {
  const resend = client();
  if (!resend) {
    console.log(`[email] confirm ${email} ${confirmationUrl}`);
    return;
  }
  await resend.emails.send({
    from: env.resendFrom,
    to: email,
    subject: "Confirm your Whootaloo email",
    html: wrap(
      "Confirm your email",
      "Welcome to Whootaloo. Click the link below to verify your email address.",
      confirmationUrl,
      "Confirm Email",
    ),
  });
}

export async function sendPasswordResetEmail(email: string, resetUrl: string) {
  const resend = client();
  if (!resend) {
    console.log(`[email] reset ${email} ${resetUrl}`);
    return;
  }
  await resend.emails.send({
    from: env.resendFrom,
    to: email,
    subject: "Reset your Whootaloo password",
    html: wrap(
      "Reset your password",
      "We received a request to reset your password. This link is valid for 15 minutes.",
      resetUrl,
      "Reset Password",
    ),
  });
}
