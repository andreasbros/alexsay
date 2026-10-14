import { describe, expect, it } from "vitest";
import { MailError, type SmtpConfig, type SmtpSocket, sendSmtp } from "../src/mail";
import { escapeHtml, inviteEmail, loginEmail } from "../src/mail_templates";

const config: SmtpConfig = {
  host: "smtp.example.test",
  port: 465,
  user: "api_token",
  password: "secret",
  from: "alexsay <hello@alexsay.test>",
};
const mail = { to: "maria@example.com", subject: "Grüße", html: "<p>hi</p>", text: ".hi\nthere" };

/** A scripted SMTP server: every command gets the next canned reply; a reply list can override any step. */
function server(replies: Partial<Record<string, string>> = {}) {
  const log: string[] = [];
  let tlsStarted = false;
  const make = (tls: boolean): SmtpSocket => {
    let push: (text: string) => void = () => undefined;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(new TextEncoder().encode(text));
        if (!tls) {
          push("220 smtp.example.test ready\r\n");
        }
      },
    });
    let pending = "";
    let inData = false;
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        pending += new TextDecoder().decode(chunk);
        for (;;) {
          if (inData) {
            const end = pending.indexOf("\r\n.\r\n");
            if (end < 0) {
              return;
            }
            log.push(`DATA-BODY ${pending.slice(0, end)}`);
            pending = pending.slice(end + 5);
            inData = false;
            push(replies.body ?? "250 queued\r\n");
            continue;
          }
          const end = pending.indexOf("\r\n");
          if (end < 0) {
            return;
          }
          const line = pending.slice(0, end);
          pending = pending.slice(end + 2);
          log.push(`${tls ? "tls " : ""}${line}`);
          const verb = line.split(" ")[0] ?? "";
          if (verb === "EHLO") {
            push("250-smtp.example.test\r\n250-AUTH PLAIN\r\n250 STARTTLS\r\n");
          } else if (verb === "STARTTLS") {
            push("220 go ahead\r\n");
          } else if (verb === "AUTH") {
            push(replies.auth ?? "235 ok\r\n");
          } else if (verb === "DATA") {
            inData = true;
            push("354 send it\r\n");
          } else if (verb === "QUIT") {
            push("221 bye\r\n");
          } else {
            push(replies[verb] ?? "250 ok\r\n");
          }
        }
      },
    });
    return {
      readable,
      writable,
      startTls: () => {
        tlsStarted = true;
        return make(true);
      },
      close: async () => undefined,
    };
  };
  return { log, open: (_host: string, _port: number, _tls: boolean) => make(false), tls: () => tlsStarted };
}

describe("SMTP client", () => {
  it("sends one message over implicit TLS with AUTH PLAIN and base64 bodies", async () => {
    const smtp = server();
    await sendSmtp(config, mail, smtp.open);
    expect(smtp.log.slice(0, 5)).toEqual([
      "EHLO alexsay.test",
      `AUTH PLAIN ${btoa("\0api_token\0secret")}`,
      "MAIL FROM:<hello@alexsay.test>",
      "RCPT TO:<maria@example.com>",
      "DATA",
    ]);
    const body = smtp.log.find((line) => line.startsWith("DATA-BODY")) ?? "";
    expect(body).toContain("From: alexsay <hello@alexsay.test>");
    expect(body).toContain("Subject: =?UTF-8?B?");
    expect(body).toContain("Content-Transfer-Encoding: base64");
    expect(body).toContain(btoa(".hi\nthere"));
    expect(body).not.toMatch(/\r\n\./);
    expect(smtp.tls()).toBe(false);
  });

  it("upgrades with STARTTLS on any other port before signing in", async () => {
    const smtp = server();
    await sendSmtp({ ...config, port: 587 }, mail, smtp.open);
    expect(smtp.tls()).toBe(true);
    expect(smtp.log.slice(0, 4)).toEqual([
      "EHLO alexsay.test",
      "STARTTLS",
      "tls EHLO alexsay.test",
      expect.any(String),
    ]);
    expect(smtp.log[3]).toMatch(/^tls AUTH PLAIN /);
  });

  it("fails on a refused step and refuses header injection", async () => {
    await expect(sendSmtp(config, mail, server({ auth: "535 bad credentials\r\n" }).open)).rejects.toThrow(
      /SMTP AUTH: 535/,
    );
    await expect(sendSmtp(config, mail, server({ RCPT: "550 no such user\r\n" }).open)).rejects.toThrow(MailError);
    await expect(sendSmtp(config, { ...mail, subject: "hi\r\nBcc: x@y.z" }, server().open)).rejects.toThrow(
      /line break/,
    );
  });
});

describe("email templates", () => {
  it("escapes everything they interpolate into HTML", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    const invite = inviteEmail({
      home: "<b>Flat</b>",
      inviter: "maria",
      link: "https://x.test/invite#token=a",
      days: 3,
    });
    expect(invite.html).toContain("&lt;b&gt;Flat&lt;/b&gt;");
    expect(invite.html).not.toContain("<b>Flat</b>");
    expect(invite.text).toContain("https://x.test/invite#token=a");
    const login = loginEmail({ code: "012345", link: "https://x.test/sign-in/email#token=b", minutes: 10 });
    expect(login.subject).toContain("012345");
    expect(login.html).toContain("012345");
    expect(login.text).toContain("10 minutes");
  });
});
