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

function card(title: string, body: string, href: string, label: string) {
  const safeHref = escapeHtml(href);
  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#0B0C0B;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0B0C0B;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="420" cellpadding="0" cellspacing="0" style="max-width:420px;width:100%;background:#121412;border:1px solid #242824;border-radius:12px;">
          <tr>
            <td style="padding:28px 28px 0;font-family:Georgia,'Times New Roman',serif;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#C5CDC4;">
              Whootaloo
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px 0;">
              <div style="height:1px;background:#2A2E2A;line-height:1px;font-size:1px;">&nbsp;</div>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 28px 0;font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.3;color:#E6E6E2;">
              ${escapeHtml(title)}
            </td>
          </tr>
          <tr>
            <td style="padding:12px 28px 0;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.55;color:#8A908A;">
              ${escapeHtml(body)}
            </td>
          </tr>
          <tr>
            <td style="padding:24px 28px 0;">
              <a href="${safeHref}" style="display:inline-block;padding:11px 16px;border:1px solid #3A3E3A;border-radius:8px;font-family:Georgia,'Times New Roman',serif;font-size:13px;letter-spacing:0.06em;color:#E6E6E2;text-decoration:none;">
                ${escapeHtml(label)}
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 28px 28px;font-family:Georgia,'Times New Roman',serif;font-size:11px;line-height:1.5;color:#6A706A;word-break:break-all;">
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
