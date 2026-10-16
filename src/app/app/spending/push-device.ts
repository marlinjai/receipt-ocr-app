/**
 * Switching push on or off on this device, in the browser. The steps are the
 * web standards (notification permission, the service worker's push manager);
 * they are passed in, so the flow is tested without a browser.
 */

export interface PushEnvironment {
  /** The service worker registration, or null when the worker is not running (yet). */
  registration(): Promise<{ pushManager: PushManagerLike } | null>;
  /** Must be called straight from the tap: Safari refuses the prompt once the tap is over. */
  requestPermission(): Promise<NotificationPermission>;
}

export interface PushManagerLike {
  getSubscription(): Promise<SubscriptionLike | null>;
  subscribe(options: { userVisibleOnly: true; applicationServerKey: Uint8Array }): Promise<SubscriptionLike>;
}

export interface SubscriptionLike {
  endpoint: string;
  toJSON(): unknown;
  unsubscribe(): Promise<boolean>;
}

export type PushSwitchResult =
  | { ok: true; subscription: unknown; endpoint: string }
  | { ok: false; reason: 'unsupported' | 'no_worker' | 'denied' | 'dismissed' | 'failed' };

/** The server's public key (base64url) as the bytes the push manager wants. */
export function keyBytes(base64url: string): Uint8Array {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * Switch push on here. The permission is asked first, before anything is
 * awaited, so it still counts as the tap's own action on the iPhone.
 */
export async function switchPushOn(env: PushEnvironment, publicKey: string): Promise<PushSwitchResult> {
  const permissionAsked = env.requestPermission().catch(() => 'denied' as NotificationPermission);
  const permission = await permissionAsked;
  if (permission === 'denied') return { ok: false, reason: 'denied' };
  if (permission !== 'granted') return { ok: false, reason: 'dismissed' };
  const registration = await env.registration().catch(() => null);
  if (!registration) return { ok: false, reason: 'no_worker' };
  try {
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
    return { ok: true, subscription: subscription.toJSON(), endpoint: subscription.endpoint };
  } catch (e) {
    console.warn('[push] subscribe failed', e);
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Switch push off here. The browser's subscription ends only when no other
 * company of this person still uses it (one browser has one subscription per
 * site). Returns the address the server should forget for this company, or
 * null when the device had none.
 */
export async function switchPushOff(env: PushEnvironment, usedElsewhere: boolean): Promise<string | null> {
  const registration = await env.registration().catch(() => null);
  const subscription = registration ? await registration.pushManager.getSubscription().catch(() => null) : null;
  if (!subscription) return null;
  const endpoint = subscription.endpoint;
  if (!usedElsewhere) await subscription.unsubscribe().catch(() => false);
  return endpoint;
}

/** This device's current subscription (address and keys), or null. */
export async function currentSubscription(env: PushEnvironment): Promise<{ endpoint: string; json: unknown } | null> {
  const registration = await env.registration().catch(() => null);
  const subscription = registration ? await registration.pushManager.getSubscription().catch(() => null) : null;
  return subscription ? { endpoint: subscription.endpoint, json: subscription.toJSON() } : null;
}

/** The real browser, or null when it offers no push (no service worker, no push manager, no notifications). */
export function browserPushEnvironment(): PushEnvironment | null {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return null;
  return {
    registration: async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg ? (reg as unknown as { pushManager: PushManagerLike }) : null;
    },
    requestPermission: () => Notification.requestPermission(),
  };
}

/** What happened, in words a person can act on. */
export function pushSwitchMessage(result: PushSwitchResult): string {
  if (result.ok) return 'Push ist auf diesem Gerät eingeschaltet.';
  switch (result.reason) {
    case 'unsupported':
      return 'Dieses Gerät oder dieser Browser bietet kein Push für die App. Auf dem iPhone geht es nur aus der installierten App (zum Home-Bildschirm hinzugefügt).';
    case 'no_worker':
      return 'Die App ist auf diesem Gerät noch nicht bereit für Push. Bitte die Seite neu laden und noch einmal versuchen.';
    case 'denied':
      return 'Mitteilungen sind für die App nicht erlaubt. Sie lassen sich in den Einstellungen des Geräts erlauben.';
    case 'dismissed':
      return 'Die Frage nach Mitteilungen wurde geschlossen. Zum Einschalten bitte noch einmal tippen und „Erlauben“ wählen.';
    default:
      return 'Push ließ sich nicht einschalten. Bitte noch einmal versuchen.';
  }
}
