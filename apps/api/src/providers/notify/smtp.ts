/**
 * A minimal SMTP client.
 *
 * Enough of RFC 5321 to submit mail through a relay: EHLO, STARTTLS, AUTH
 * PLAIN/LOGIN, MAIL FROM, RCPT TO, DATA. Deliberately not a mail server and
 * deliberately not a full library — a self-hosted deployment relays through
 * something (Postfix on the same box, or a provider), and this is the client
 * side of that conversation.
 *
 * STARTTLS is attempted whenever the server advertises it and is required
 * unless the relay is on the loopback interface, because credentials and a
 * resident's balance should not cross a network in the clear.
 */

import net from "node:net";
import tls from "node:tls";
import { randomUUID } from "node:crypto";
import type { Transport } from "./index.ts";
import type { NotificationChannel } from "../../../../../packages/shared/src/notifications.ts";

export interface SmtpOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  fromAddress: string;
  fromName: string;
  /** Refuse to send if the relay does not offer STARTTLS. Default: off-loopback. */
  requireTls?: boolean;
  timeoutMs?: number;
}

export class SmtpTransport implements Transport {
  readonly name = "smtp";
  private readonly options: SmtpOptions;

  constructor(options: SmtpOptions) {
    this.options = { timeoutMs: 15_000, ...options };
  }

  async send(message: {
    channel: NotificationChannel;
    to: string;
    subject: string;
    body: string;
  }): Promise<void> {
    if (message.channel !== "email") {
      throw new Error(`the SMTP transport cannot deliver over ${message.channel}`);
    }
    const session = new SmtpSession(this.options);
    try {
      await session.connect();
      await session.deliver(message.to, message.subject, message.body);
    } finally {
      await session.close();
    }
  }
}

class SmtpSession {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = "";
  private pending: { resolve: (lines: string[]) => void; reject: (e: Error) => void } | null = null;
  private readonly options: SmtpOptions;
  private capabilities: string[] = [];

  constructor(options: SmtpOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    this.socket = await this.open();
    this.attach(this.socket);

    await this.expect(220);
    this.capabilities = await this.ehlo();

    const loopback = ["127.0.0.1", "::1", "localhost"].includes(this.options.host);
    const offersTls = this.capabilities.some((c) => c.toUpperCase().startsWith("STARTTLS"));
    const requireTls = this.options.requireTls ?? !loopback;

    if (offersTls) {
      await this.command("STARTTLS", 220);
      const secure = tls.connect({ socket: this.socket, servername: this.options.host });
      await new Promise<void>((resolve, reject) => {
        secure.once("secureConnect", () => resolve());
        secure.once("error", reject);
      });
      this.socket = secure;
      this.attach(secure);
      // Capabilities are renegotiated after the upgrade; the pre-TLS list is
      // not trustworthy and, per RFC 3207, must be discarded.
      this.capabilities = await this.ehlo();
    } else if (requireTls) {
      throw new Error(
        `${this.options.host}:${this.options.port} does not offer STARTTLS. ` +
          `Set SMTP_REQUIRE_TLS=false only if the relay is on this machine.`,
      );
    }

    if (this.options.user) {
      await this.authenticate();
    }
  }

  private async ehlo(): Promise<string[]> {
    const lines = await this.command(`EHLO ${hostnameFor(this.options.fromAddress)}`, 250);
    return lines.slice(1);
  }

  private async authenticate(): Promise<void> {
    const supports = (mechanism: string) =>
      this.capabilities.some((c) => c.toUpperCase().includes(mechanism));

    if (supports("PLAIN")) {
      const credentials = Buffer.from(
        `\0${this.options.user}\0${this.options.password}`,
        "utf8",
      ).toString("base64");
      await this.command(`AUTH PLAIN ${credentials}`, 235);
      return;
    }

    if (supports("LOGIN")) {
      await this.command("AUTH LOGIN", 334);
      await this.command(Buffer.from(this.options.user, "utf8").toString("base64"), 334);
      await this.command(Buffer.from(this.options.password, "utf8").toString("base64"), 235);
      return;
    }

    throw new Error("the relay offers no authentication mechanism this client supports");
  }

  async deliver(to: string, subject: string, body: string): Promise<void> {
    await this.command(`MAIL FROM:<${this.options.fromAddress}>`, 250);
    await this.command(`RCPT TO:<${to}>`, 250);
    await this.command("DATA", 354);

    const headers = [
      `From: ${encodeHeader(this.options.fromName)} <${this.options.fromAddress}>`,
      `To: <${to}>`,
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomUUID()}@${hostnameFor(this.options.fromAddress)}>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      // These are transactional notices about somebody's housing; they should
      // not end up in a promotional tab or be auto-replied to.
      "Auto-Submitted: auto-generated",
      "X-Auto-Response-Suppress: All",
    ];

    // Dot-stuffing: a line consisting of a single "." would otherwise end the
    // message early, which is a real way to truncate a notice at exactly the
    // wrong place.
    const escaped = body.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");

    this.write(`${headers.join("\r\n")}\r\n\r\n${escaped}\r\n.\r\n`);
    await this.expect(250);
  }

  async close(): Promise<void> {
    try {
      if (this.socket && !this.socket.destroyed) {
        this.write("QUIT\r\n");
        await this.expect(221).catch(() => {});
      }
    } finally {
      this.socket?.destroy();
      this.socket = null;
    }
  }

  private open(): Promise<net.Socket | tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      // Port 465 is implicit TLS; 587 and 25 start plain and upgrade.
      const socket =
        this.options.port === 465
          ? tls.connect({ host: this.options.host, port: this.options.port, servername: this.options.host })
          : net.connect({ host: this.options.host, port: this.options.port });

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`timed out connecting to SMTP relay ${this.options.host}:${this.options.port}`));
      }, this.options.timeoutMs ?? 15_000);

      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once(this.options.port === 465 ? "secureConnect" : "connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
    });
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    socket.setEncoding("utf8");
    socket.removeAllListeners("data");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      // A multi-line reply uses "250-" for every line but the last, which is
      // "250 ". Waiting for that space is how the framing works.
      const match = this.buffer.match(/^(\d{3}) [^\n]*\r?\n$/m);
      if (!match && !/^\d{3} /m.test(this.buffer.split(/\r?\n/).filter(Boolean).pop() ?? "")) return;

      const lines = this.buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (!/^\d{3} /.test(last)) return;

      this.buffer = "";
      const waiter = this.pending;
      this.pending = null;
      waiter?.resolve(lines);
    });
  }

  private write(data: string): void {
    this.socket?.write(data);
  }

  private command(line: string, expected: number): Promise<string[]> {
    this.write(`${line}\r\n`);
    return this.expect(expected);
  }

  private expect(code: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`SMTP relay did not answer within ${this.options.timeoutMs}ms`)),
        this.options.timeoutMs ?? 15_000,
      );

      this.pending = {
        resolve: (lines) => {
          clearTimeout(timer);
          const status = Number(lines[lines.length - 1].slice(0, 3));
          if (status !== code) {
            reject(new Error(`SMTP expected ${code} but received: ${lines.join(" | ")}`));
            return;
          }
          resolve(lines.map((l) => l.slice(4)));
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }
}

/** RFC 2047 encoded-word, for any header that is not plain ASCII. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function hostnameFor(address: string): string {
  return address.split("@")[1] ?? "localhost";
}

/**
 * SMS over a generic HTTP endpoint. Deliberately shaped as "POST a JSON body to
 * a URL you configure" rather than as a client for one vendor, so that an
 * operator can point it at whatever they already use.
 */
export class HttpSmsTransport implements Transport {
  readonly name = "http-sms";
  private readonly endpoint: string;
  private readonly token: string;

  constructor(endpoint: string, token: string) {
    this.endpoint = endpoint;
    this.token = token;
  }

  async send(message: { channel: NotificationChannel; to: string; subject: string; body: string }): Promise<void> {
    if (message.channel !== "sms") throw new Error("this transport sends SMS only");
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ to: message.to, body: message.body }),
    });
    if (!response.ok) {
      throw new Error(`SMS endpoint returned ${response.status}`);
    }
  }
}

/** Routes each message to whichever transport handles its channel. */
export class ChannelRouter implements Transport {
  readonly name = "router";
  private readonly transports: Partial<Record<NotificationChannel, Transport>>;
  private readonly fallback: Transport;

  constructor(transports: Partial<Record<NotificationChannel, Transport>>, fallback: Transport) {
    this.transports = transports;
    this.fallback = fallback;
  }

  send(message: { channel: NotificationChannel; to: string; subject: string; body: string }): Promise<void> {
    return (this.transports[message.channel] ?? this.fallback).send(message);
  }
}
