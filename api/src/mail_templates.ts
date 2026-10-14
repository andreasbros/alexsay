import type { Mail } from "./mail";

export type MailBody = Omit<Mail, "to">;

const ACCENT = "#4f46e5";
const ACCENT_END = "#7c3aed";

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Table layout with bgcolor attributes: Gmail's light theme repaints CSS-only backgrounds and
 * inverts the text, but leaves bgcolor alone. Everything passed in is already escaped.
 */
function shell(body: string, footer: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#0b0b12;color:#e8e8f0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0b0b12" style="background:#0b0b12">
<tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#14141f" style="max-width:460px;background:#14141f;border:1px solid #26263a;border-radius:18px;overflow:hidden">
  <tr><td bgcolor="${ACCENT}" style="background:${ACCENT};background:linear-gradient(135deg,${ACCENT},${ACCENT_END});padding:20px 28px" align="center">
    <span style="font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:700;letter-spacing:1px;color:#ffffff">alexsay</span>
  </td></tr>
  <tr><td bgcolor="#14141f" style="background:#14141f;padding:30px 28px;font-family:Arial,Helvetica,sans-serif;color:#e8e8f0">
    ${body}
  </td></tr>
  <tr><td bgcolor="#14141f" style="background:#14141f;padding:18px 28px;border-top:1px solid #23233a;font-family:Arial,Helvetica,sans-serif" align="center">
    <p style="margin:0;font-size:11px;line-height:1.6;color:#7a7a90">${footer}</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function button(link: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:20px"><tr><td align="center">
      <a href="${escapeHtml(link)}" style="display:inline-block;background:${ACCENT};color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;padding:15px 40px;border-radius:50px">${label} &rarr;</a>
    </td></tr></table>`;
}

function codeBox(code: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td align="center" bgcolor="#0b0b12"
      style="background:#0b0b12;border:1px dashed #3a3a55;border-radius:12px;padding:16px">
      <span style="font-family:'Courier New',monospace;font-size:30px;font-weight:700;letter-spacing:10px;color:#ffffff">${escapeHtml(code)}</span>
    </td></tr></table>`;
}

const IGNORE = "Wasn't you? Ignore this email: nothing happens without the code or the link.";

export function loginEmail({ code, link, minutes }: { code: string; link: string; minutes: number }): MailBody {
  const html = shell(
    `<h1 style="margin:0 0 14px;font-size:19px;color:#ffffff" align="center">Your sign-in code</h1>
    ${codeBox(code)}
    <p style="margin:22px 0 0;font-size:14px;line-height:1.6;color:#b9b9cc" align="center">Type the code, or sign in with one tap.</p>
    ${button(link, "Sign in")}
    <p style="margin:22px 0 0;font-size:12px;color:#8a8aa0" align="center">The code and the link work once, for ${minutes} minutes.</p>`,
    `Someone asked to sign in to alexsay with this address. ${IGNORE}`,
  );
  const text = [
    "Your alexsay sign-in code:",
    "",
    `    ${code}`,
    "",
    `Or sign in with one tap: ${link}`,
    "",
    `The code and the link work once, for ${minutes} minutes.`,
    "",
    `Someone asked to sign in to alexsay with this address. ${IGNORE}`,
  ].join("\n");
  return { subject: `alexsay sign-in code: ${code}`, html, text };
}

export function confirmEmail({
  code,
  username,
  minutes,
}: {
  code: string;
  username: string;
  minutes: number;
}): MailBody {
  const html = shell(
    `<h1 style="margin:0 0 14px;font-size:19px;color:#ffffff" align="center">Confirm your email</h1>
    <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#b9b9cc" align="center">
      Enter this code in alexsay to add this address to <strong style="color:#ffffff">${escapeHtml(username)}</strong>.
      You can then sign in with it.
    </p>
    ${codeBox(code)}
    <p style="margin:22px 0 0;font-size:12px;color:#8a8aa0" align="center">The code works once, for ${minutes} minutes.</p>`,
    `Someone asked to add this address to an alexsay account. ${IGNORE}`,
  );
  const text = [
    `Confirm your email for the alexsay account ${username}:`,
    "",
    `    ${code}`,
    "",
    `The code works once, for ${minutes} minutes.`,
    "",
    `Someone asked to add this address to an alexsay account. ${IGNORE}`,
  ].join("\n");
  return { subject: "Confirm your email for alexsay", html, text };
}

export function inviteEmail({
  home,
  inviter,
  link,
  days,
}: {
  home: string;
  inviter: string;
  link: string;
  days: number;
}): MailBody {
  const html = shell(
    `<h1 style="margin:0 0 14px;font-size:19px;color:#ffffff" align="center">Join <span style="color:#a5b4fc">${escapeHtml(home)}</span> on alexsay</h1>
    <p style="margin:0 0 4px;font-size:14px;line-height:1.6;color:#b9b9cc" align="center">
      ${escapeHtml(inviter)} invited you to their home: its speakers, its assistant and everything it remembers.
    </p>
    ${button(link, "Join the home")}
    <p style="margin:22px 0 0;font-size:12px;color:#8a8aa0" align="center">The link signs you in (and makes your account if you have none). It works for ${days} days.</p>`,
    "You got this because someone typed your address into alexsay. Not expecting it? Ignore this email.",
  );
  const text = [
    `${inviter} invited you to join ${home} on alexsay.`,
    "",
    `Join: ${link}`,
    "",
    `The link signs you in (and makes your account if you have none). It works for ${days} days.`,
    "",
    "You got this because someone typed your address into alexsay. Not expecting it? Ignore this email.",
  ].join("\n");
  return { subject: `${inviter} invited you to ${home} on alexsay`, html, text };
}
