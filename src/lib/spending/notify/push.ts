import type { DeliveryOutcome, NotificationChannel } from './port';

/**
 * Push to the installed phone app. Prepared behind the port: the owner chose
 * push as the default channel, and until this channel can deliver, every
 * notification falls back to e-mail and always stays in the app. Delivering
 * needs a push subscription stored from the phone and the server's
 * Voluntary Application Server Identification (VAPID) key pair
 * (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`); both come with
 * the push change that follows this one.
 */
export function createPushChannel(): NotificationChannel {
  return {
    name: 'push',
    async send(): Promise<DeliveryOutcome> {
      return { status: 'unavailable', detail: 'push is not set up yet' };
    },
  };
}
