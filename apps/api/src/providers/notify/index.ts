import type { NotificationChannel } from "../../../../../packages/shared/src/notifications.ts";

/**
 * One interface for every way of reaching a person, so that a provider can be
 * swapped without touching business logic. The domain layer knows about
 * channels and addresses; it knows nothing about SMTP or any vendor's API.
 */
export interface Transport {
  readonly name: string;
  send(message: {
    channel: NotificationChannel;
    to: string;
    subject: string;
    body: string;
  }): Promise<void>;
}
