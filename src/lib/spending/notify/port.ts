/**
 * The notification port: one way to tell the owner something, whatever the
 * channel. Every notification is first written to the in-app queue (the
 * notifications table, shown on the spending page), so nothing is lost when no
 * channel can deliver it. Then the channels are tried in the order of the
 * workspace's setting; the first that delivers wins.
 *
 * The owner decided on 2026-10-15: push to the installed phone app by default,
 * e-mail when push is not possible (no subscription, or delivery failed).
 */

export type ChannelName = 'push' | 'email';

/** What the owner chose. 'push' means push, then e-mail as the fallback. */
export type ChannelSetting = 'push' | 'email' | 'in_app';
export const CHANNEL_SETTINGS: readonly ChannelSetting[] = ['push', 'email', 'in_app'];
export const DEFAULT_CHANNEL: ChannelSetting = 'push';

export type NotificationKind = 'missing_receipt' | 'budget';

export interface NotificationMessage {
  /** Makes the notification happen at most once: a second one with the same subject is not sent. */
  subjectKey: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** The page in the app that answers it, as a path ("/app/spending?pruefen=..."). */
  path: string;
}

export interface Recipient {
  workspaceId: string;
  /** The address e-mails go to; null: e-mail is not possible. */
  email: string | null;
}

export type DeliveryOutcome =
  /** Delivered to the channel. */
  | { status: 'sent' }
  /** The channel cannot be used here (not configured on the server, no subscription, no address). Not an error. */
  | { status: 'unavailable'; detail: string }
  /** The channel tried and failed. */
  | { status: 'failed'; detail: string };

export interface NotificationChannel {
  readonly name: ChannelName;
  send(recipient: Recipient, message: NotificationMessage): Promise<DeliveryOutcome>;
}

/** The channels to try, in order, for a setting. */
export function channelOrder(setting: ChannelSetting): ChannelName[] {
  if (setting === 'push') return ['push', 'email'];
  if (setting === 'email') return ['email'];
  return [];
}

export interface DeliveryResult {
  /** The channel that delivered, or null: the notification is in the app only. */
  channel: ChannelName | null;
  /** One line per channel tried, for the record ("push: unavailable (no subscription)"). */
  attempts: string[];
  /** True when a channel was tried and failed (not merely unavailable): worth another try later. */
  failed: boolean;
}

/** Try the channels in order. A channel that throws counts as failed; the next one is tried. */
export async function deliverThroughChannels(
  channels: readonly NotificationChannel[],
  setting: ChannelSetting,
  recipient: Recipient,
  message: NotificationMessage,
): Promise<DeliveryResult> {
  const attempts: string[] = [];
  let failed = false;
  for (const name of channelOrder(setting)) {
    const channel = channels.find((c) => c.name === name);
    if (!channel) {
      attempts.push(`${name}: unavailable (not set up)`);
      continue;
    }
    let outcome: DeliveryOutcome;
    try {
      outcome = await channel.send(recipient, message);
    } catch (e) {
      outcome = { status: 'failed', detail: e instanceof Error ? e.message : 'error' };
    }
    if (outcome.status === 'sent') {
      attempts.push(`${name}: sent`);
      return { channel: name, attempts, failed: false };
    }
    if (outcome.status === 'failed') failed = true;
    attempts.push(`${name}: ${outcome.status} (${outcome.detail})`);
  }
  return { channel: null, attempts, failed };
}
