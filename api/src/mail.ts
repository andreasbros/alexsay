import { connect } from "cloudflare:sockets";

/** An email ready to send: both an HTML and a plain-text body, like every template makes. */
export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** `alexsay <hello@alexsay.com>` or a bare address. */
  from: string;
}

/** The part of a Workers socket the client uses; tests hand in a scripted server. */
export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  startTls(): SmtpSocket;
  close(): Promise<void>;
}

export type SocketOpener = (host: string, port: number, implicitTls: boolean) => SmtpSocket;

const openSocket: SocketOpener = (host, port, implicitTls) =>
  connect({ hostname: host, port }, { secureTransport: implicitTls ? "on" : "starttls", allowHalfOpen: false });

/**
 * How mail leaves this server: Cloudflare's Email Service binding on Cloudflare (Workers cannot open
 * sockets to Cloudflare's own addresses, its SMTP relay included), an SMTP relay anywhere else.
 */
export type MailRoute = { via: "binding"; binding: SendEmail; from: string } | { via: "smtp"; smtp: SmtpConfig };

/** Tests swap `send` for a recorder. */
export const transport = {
  send: (route: MailRoute, mail: Mail) =>
    route.via === "binding" ? sendViaBinding(route.binding, route.from, mail) : sendSmtp(route.smtp, mail, openSocket),
};

/** The route mail takes, or null when this server has no way to send email. */
export function mailRoute(env: Env): MailRoute | null {
  const from = env.EMAIL_FROM?.trim();
  if (env.EMAIL && from) {
    return { via: "binding", binding: env.EMAIL, from };
  }
  const smtp = smtpConfig(env);
  return smtp ? { via: "smtp", smtp } : null;
}

/** Where the server settings say mail goes, for admins. */
export function mailDescription(route: MailRoute): { through: string; from: string } {
  return route.via === "binding"
    ? { through: "Cloudflare Email Service", from: route.from }
    : { through: route.smtp.host, from: route.smtp.from };
}

export function smtpConfig(env: Env): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  const user = env.SMTP_USER?.trim();
  const password = env.SMTP_PASSWORD;
  const from = env.EMAIL_FROM?.trim();
  if (!host || !user || !password || !from) {
    return null;
  }
  return { host, port: Number(env.SMTP_PORT?.trim() || "465"), user, password, from };
}

export class MailError extends Error {}

export async function sendMail(env: Env, mail: Mail): Promise<void> {
  const route = mailRoute(env);
  if (!route) {
    throw new MailError("email is not configured on this server");
  }
  await transport.send(route, mail);
}

export async function sendViaBinding(binding: SendEmail, from: string, mail: Mail): Promise<void> {
  const name = /^\s*"?([^"<]*?)"?\s*</.exec(from)?.[1]?.trim();
  const email = addressOf(from).trim();
  try {
    await binding.send({
      from: name ? { name, email } : email,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new MailError(`Email Service: ${typeof code === "string" ? `${code} ` : ""}${String(error)}`);
  }
}

const encoder = new TextEncoder();

/**
 * One message per connection: port 465 is TLS from the first byte (Cloudflare's relay), any other
 * port upgrades with STARTTLS (587). AUTH PLAIN only ever goes over TLS.
 */
export async function sendSmtp(config: SmtpConfig, mail: Mail, open: SocketOpener): Promise<void> {
  for (const value of [mail.to, mail.subject, config.from]) {
    if (/[\r\n]/.test(value)) {
      throw new MailError("line break in an email header");
    }
  }
  const implicitTls = config.port === 465;
  const plain = open(config.host, config.port, implicitTls);
  let session = new SmtpSession(plain);
  try {
    await session.expect("220", "greeting");
    const helo = `EHLO ${domainOf(config.from)}`;
    await session.command(helo, "250");
    if (!implicitTls) {
      await session.command("STARTTLS", "220");
      session.release();
      session = new SmtpSession(plain.startTls());
      await session.command(helo, "250");
    }
    await session.command(`AUTH PLAIN ${btoa(`\0${config.user}\0${config.password}`)}`, "235");
    await session.command(`MAIL FROM:<${addressOf(config.from)}>`, "250");
    await session.command(`RCPT TO:<${mail.to}>`, "250", "251");
    await session.command("DATA", "354");
    await session.write(`${message(config, mail)}\r\n.`);
    await session.expect("250", "message");
    await session.command("QUIT", "221").catch(() => undefined);
  } finally {
    await session.close();
  }
}

class SmtpSession {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(private readonly socket: SmtpSocket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  write(line: string): Promise<void> {
    return this.writer.write(encoder.encode(`${line}\r\n`));
  }

  async command(line: string, ...accepted: string[]): Promise<string> {
    await this.write(line);
    return this.expect(accepted, line.split(" ")[0] ?? line);
  }

  /** Reads one whole reply (multi-line replies end with "NNN " on their last line). */
  async expect(accepted: string | string[], step: string): Promise<string> {
    const codes = Array.isArray(accepted) ? accepted : [accepted];
    for (;;) {
      const lines = this.buffer.split("\r\n");
      const done = lines.findIndex((line) => /^\d{3}( |$)/.test(line));
      if (done >= 0 && done < lines.length - 1) {
        const reply = lines.slice(0, done + 1).join("\n");
        this.buffer = lines.slice(done + 1).join("\r\n");
        const code = reply.slice(reply.lastIndexOf("\n") + 1, reply.lastIndexOf("\n") + 4);
        if (!codes.includes(code)) {
          throw new MailError(`SMTP ${step}: ${reply.slice(0, 200)}`);
        }
        return reply;
      }
      const { value, done: closed } = await this.reader.read();
      if (closed) {
        throw new MailError(`SMTP ${step}: connection closed`);
      }
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  /** Hands the plain streams back before the TLS upgrade, which reuses them. */
  release(): void {
    this.reader.releaseLock();
    this.writer.releaseLock();
  }

  async close(): Promise<void> {
    await this.socket.close().catch(() => undefined);
  }
}

function addressOf(from: string): string {
  return /<([^>]+)>/.exec(from)?.[1] ?? from;
}

function domainOf(from: string): string {
  return addressOf(from).split("@")[1] ?? "localhost";
}

/** RFC 2047 for a subject with anything beyond ASCII. */
function headerText(text: string): string {
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${base64(text)}?=`;
}

function base64(text: string): string {
  const bytes = encoder.encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Base64 bodies: no line-length limits and no lines starting with a dot to escape. */
function wrapped(text: string): string {
  return base64(text)
    .replace(/.{1,76}/g, "$&\r\n")
    .trimEnd();
}

function message(config: SmtpConfig, mail: Mail): string {
  const boundary = `alexsay-${crypto.randomUUID()}`;
  return [
    `From: ${config.from}`,
    `To: <${mail.to}>`,
    `Subject: ${headerText(mail.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domainOf(config.from)}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapped(mail.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapped(mail.html),
    `--${boundary}--`,
  ].join("\r\n");
}
