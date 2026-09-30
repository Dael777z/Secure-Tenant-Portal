/**
 * A transport that writes messages to disk and to the log instead of sending
 * them. The development and test default.
 *
 * Writing them to a file rather than only printing them is deliberate: the
 * message-comprehension test the proposal commits to — showing a resident a
 * failure notice cold and asking what it means — needs the actual rendered text,
 * and reading it out of a terminal scrollback is not a study protocol.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Transport } from "./index.ts";
import type { NotificationChannel } from "../../../../../packages/shared/src/notifications.ts";

export class ConsoleTransport implements Transport {
  readonly name = "console";
  private readonly directory: string;
  private readonly log: (message: string) => void;

  constructor(directory: string, log: (message: string) => void = () => {}) {
    this.directory = directory;
    this.log = log;
  }

  async send(message: {
    channel: NotificationChannel;
    to: string;
    subject: string;
    body: string;
  }): Promise<void> {
    const stamp = new Date().toISOString();
    const rendered =
      `${"=".repeat(78)}\n` +
      `${stamp}  ${message.channel.toUpperCase()} -> ${message.to}\n` +
      (message.subject ? `Subject: ${message.subject}\n` : "") +
      `${"-".repeat(78)}\n${message.body}\n\n`;

    this.log(`[notify:${message.channel}] ${message.to} — ${message.subject || message.body.slice(0, 60)}`);

    try {
      await mkdir(this.directory, { recursive: true });
      await appendFile(path.join(this.directory, "outbox.log"), rendered, "utf8");
    } catch {
      // A dev transport that cannot write its log should not fail a payment.
    }
  }
}
