import { Resend } from "resend";
import { env } from "../env.js";

function client() {
  if (!env.resendApiKey) return null;
  return new Resend(env.resendApiKey);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const display =
  "Quicksand,'Trebuchet MS','Segoe UI',Helvetica,Arial,sans-serif";
const sans = "'Segoe UI',Helvetica,Arial,sans-serif";

function card(title: string, body: string, href: string, label: string) {
  const safeHref = escapeHtml(href);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@500;600&display=swap" rel="stylesheet" />
</head>
<body style="margin:0;padding:0;background:#E8EBE6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E8EBE6;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="420" cellpadding="0" cellspacing="0" style="max-width:420px;width:100%;background:#F7F8F5;border:1px solid #D4D8D2;border-radius:10px;">
          <tr>
            <td style="padding:28px 28px 0;font-family:${display};font-size:15px;font-weight:600;letter-spacing:0.04em;color:#3A423A;">
              Whootaloo
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 0;font-family:${display};font-size:22px;font-weight:600;line-height:1.3;color:#1A1E1A;">
              ${escapeHtml(title)}
            </td>
          </tr>
          <tr>
            <td style="padding:12px 28px 0;font-family:${sans};font-size:15px;line-height:1.55;color:#5A625A;">
              ${escapeHtml(body)}
            </td>
          </tr>
          <tr>
            <td style="padding:24px 28px 0;">
              <a href="${safeHref}" style="display:inline-block;padding:11px 16px;border:1px solid #3A423A;border-radius:8px;font-family:${sans};font-size:13px;color:#1A1E1A;text-decoration:none;">
                ${escapeHtml(label)}
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 28px 28px;font-family:${sans};font-size:11px;line-height:1.5;color:#7A827A;word-break:break-all;">
              If the button does not open, paste this into a browser:<br />${safeHref}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendConfirmationEmail(email: string, confirmationUrl: string) {
  const resend = client();
  if (!resend) {
    console.log(`[email] confirm ${email} ${confirmationUrl}`);
    return;
  }
  try {
    const result = await resend.emails.send({
      from: env.resendFrom,
      to: email,
      subject: "Confirm your Whootaloo email",
      html: card(
        "Confirm your email",
        "One tap and your account is ready. This keeps Whootaloo a place for people, not bots.",
        confirmationUrl,
        "Confirm email",
      ),
    });
    console.log(`[email] confirmation sent to ${email}:`, result);
  } catch (err) {
    console.error(`[email] confirmation failed for ${email}:`, err);
    throw err;
  }
}

export async function sendInviteCodesEmail(email: string, name: string, codes: string[]) {
  const resend = client();
  const who = name.trim() || "there";
  const list = codes.map((code) => escapeHtml(code)).join("<br />");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@500;600&display=swap" rel="stylesheet" />
</head>
<body style="margin:0;padding:0;background:#E8EBE6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E8EBE6;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="420" cellpadding="0" cellspacing="0" style="max-width:420px;width:100%;background:#F7F8F5;border:1px solid #D4D8D2;border-radius:10px;">
          <tr>
            <td style="padding:28px 28px 0;font-family:${display};font-size:15px;font-weight:600;letter-spacing:0.04em;color:#3A423A;">
              Whootaloo
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 0;font-family:${display};font-size:22px;font-weight:600;line-height:1.3;color:#1A1E1A;">
              Your 7 invites
            </td>
          </tr>
          <tr>
            <td style="padding:12px 28px 0;font-family:${sans};font-size:15px;line-height:1.55;color:#5A625A;">
              ${escapeHtml(who)}, Whootaloo is invite-only for now. Each code lets one person create an account.
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 0;font-family:${display};font-size:18px;font-weight:600;letter-spacing:0.08em;line-height:1.8;color:#1A1E1A;">
              ${list}
            </td>
          </tr>
          <tr>
            <td style="padding:22px 28px 28px;font-family:${sans};font-size:13px;line-height:1.5;color:#7A827A;">
              You can also copy unused codes from Edit profile. A used code will not work again.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  if (!resend) {
    console.log(`[email] invites ${email} ${codes.join(", ")}`);
    return;
  }
  const result = await resend.emails.send({
    from: env.resendFrom,
    to: email,
    subject: "Your 7 Whootaloo invites",
    html,
  });
  console.log(`[email] invites sent to ${email}:`, result);
}

export async function sendPasswordResetEmail(email: string, resetUrl: string) {
  const resend = client();
  if (!resend) {
    console.log(`[email] reset ${email} ${resetUrl}`);
    return;
  }
  try {
    const result = await resend.emails.send({
      from: env.resendFrom,
      to: email,
      subject: "Reset your Whootaloo password",
      html: card(
        "Reset your password",
        "Someone asked to change the password on this account. The link is good for 15 minutes. If it was not you, ignore this.",
        resetUrl,
        "Choose a new password",
      ),
    });
    console.log(`[email] reset sent to ${email}:`, result);
  } catch (err) {
    console.error(`[email] reset failed for ${email}:`, err);
    throw err;
  }
}
