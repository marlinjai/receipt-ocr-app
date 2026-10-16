import type { PushSubscription, RequestOptions } from 'web-push';
import type { DeliveryOutcome, NotificationChannel, NotificationMessage, Recipient } from './port';

/**
 * Push to the installed phone app, the owner's default channel (decided
 * 2026-10-15). A message goes to every device that switched push on for the
 * workspace (and renewed it lately), signed with the server's Voluntary
 * Application Server Identification (VAPID) key pair and encrypted for each
 * device by the `web-push` library. Off until the server holds valid
 * `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (a `mailto:`
 * address the push services may write to); without a device, push is
 * unavailable and the port falls back to e-mail.
 */

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** The three settings, or null when one is missing. Whether they are valid is checked where they are used (`serverChannels`). */
export function vapidConfigFromEnv(env: Record<string, string | undefined> = process.env): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

/**
 * The push services browsers use. A device's push address must be at one of
 * them: the server sends to these addresses, so it never sends to an address
 * a person typed in (a request to an internal or foreign server).
 */
export const PUSH_SERVICE_HOSTS: ReadonlyArray<string | RegExp> = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

export function isPushServiceAddress(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  return PUSH_SERVICE_HOSTS.some((h) => (typeof h === 'string' ? url.hostname === h : h.test(url.hostname)));
}

export interface StoredSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** What the channel needs from storage: the workspace's devices, and the outcome per device. */
export interface SubscriptionStore {
  /** The devices that switched push on (and renewed it within the validity window). */
  list(workspaceId: string): Promise<StoredSubscription[]>;
  /** The push service says the device is gone (uninstalled, permission withdrawn): forget it. */
  remove(id: string, workspaceId: string): Promise<void>;
  succeeded(id: string, workspaceId: string): Promise<void>;
  /** Counts a failure; a device that failed too often in a row is forgotten. */
  failed(id: string, workspaceId: string): Promise<void>;
}

/** The sending function of `web-push`, injected so tests need no push service. */
export type SendPush = (subscription: PushSubscription, payload: string, options: RequestOptions) => Promise<{ statusCode: number }>;

/** The text a device shows, and where a tap leads. */
export function pushPayload(message: NotificationMessage): string {
  return JSON.stringify({ title: message.title, body: message.body, path: message.path, tag: message.subjectKey });
}

/** A day: a message the phone could not get within a day is not worth showing late. */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;

export function createPushChannel(config: VapidConfig | null, store: SubscriptionStore | null, send: SendPush | null): NotificationChannel {
  return {
    name: 'push',
    async send(recipient: Recipient, message: NotificationMessage): Promise<DeliveryOutcome> {
      if (!config || !store || !send) return { status: 'unavailable', detail: 'push is not configured on the server' };
      const devices = await store.list(recipient.workspaceId);
      if (devices.length === 0) return { status: 'unavailable', detail: 'no device has push switched on' };
      const payload = pushPayload(message);
      let delivered = 0;
      const problems: string[] = [];
      for (const device of devices) {
        let failure: { gone: boolean; text: string } | null = null;
        try {
          await send({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }, payload, {
            vapidDetails: config,
            TTL: PUSH_TTL_SECONDS,
            urgency: 'normal',
            // The socket's idle time in `web-push`, not a limit on the whole send.
            timeout: 15_000,
          });
        } catch (e) {
          const status = (e as { statusCode?: number })?.statusCode;
          failure = { gone: status === 404 || status === 410, text: status ? `push service answered ${status}` : e instanceof Error ? e.message : 'error' };
        }
        // The bookkeeping is apart from the send: a database hiccup never turns a delivered message into a failed one.
        try {
          if (!failure) await store.succeeded(device.id, recipient.workspaceId);
          else if (failure.gone) await store.remove(device.id, recipient.workspaceId);
          else await store.failed(device.id, recipient.workspaceId);
        } catch (e) {
          console.error('[spending] push bookkeeping failed', e);
        }
        if (!failure) delivered += 1;
        else problems.push(failure.gone ? 'device gone' : failure.text);
      }
      if (delivered > 0) return { status: 'sent' };
      // Every device was gone: push is not possible any more, which is no failure of the server.
      if (problems.every((p) => p === 'device gone')) return { status: 'unavailable', detail: 'no device has push switched on any more' };
      return { status: 'failed', detail: problems.join('; ') };
    },
  };
}
