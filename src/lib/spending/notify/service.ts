import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createEmailChannel, emailConfigFromEnv } from './email';
import {
  CHANNEL_SETTINGS,
  DEFAULT_CHANNEL,
  deliverThroughChannels,
  type ChannelSetting,
  type NotificationChannel,
  type NotificationMessage,
} from './port';
import webpush from 'web-push';
import { createPushChannel, isPushServiceAddress, vapidConfigFromEnv, type SendPush, type SubscriptionStore, type VapidConfig } from './push';

/**
 * Notifications of one workspace: the in-app queue, the setting, and delivery
 * through the port. Every read and write is scoped to the workspace passed in.
 */

export interface NotifyContext {
  workspaceId: string;
  tenantId: string | null;
}

export type NotifyServiceErrorCode = 'invalid_channel' | 'invalid_email' | 'notification_not_found' | 'invalid_subscription';

export class NotifyServiceError extends Error {
  readonly code: NotifyServiceErrorCode;
  constructor(code: NotifyServiceErrorCode) {
    super(code);
    this.name = 'NotifyServiceError';
    this.code = code;
  }
}

/** A failed delivery is tried again on later runs, at most this many times in all. */
export const MAX_DELIVERY_TRIES = 3;

export interface NotifySettings {
  channel: ChannelSetting;
  notifyEmail: string | null;
}

/**
 * The server's push keys when they are present AND valid. Wrong keys would
 * make every send fail and count against every device; they are refused once
 * here, logged, and push stays off.
 */
export function validVapidConfig(env: Record<string, string | undefined> = process.env): VapidConfig | null {
  const config = vapidConfigFromEnv(env);
  if (!config) return null;
  // Checked once per set of keys and process: a wrong key is logged once, not on every page.
  const fingerprint = `${config.subject}\n${config.publicKey}\n${config.privateKey}`;
  if (checkedVapid?.fingerprint === fingerprint) return checkedVapid.valid ? config : null;
  let valid = true;
  try {
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  } catch (e) {
    valid = false;
    console.error('[spending] the push keys on the server are not valid; push stays off', e instanceof Error ? e.message : e);
  }
  checkedVapid = { fingerprint, valid };
  return valid ? config : null;
}

let checkedVapid: { fingerprint: string; valid: boolean } | null = null;

/** The channels the server offers: push first, then e-mail. Each says by itself when it cannot deliver. */
export function serverChannels(db: PrismaClient): NotificationChannel[] {
  const send: SendPush = webpush.sendNotification;
  return [createPushChannel(validVapidConfig(), subscriptionStore(db), send), createEmailChannel(emailConfigFromEnv())];
}

/**
 * A device gets messages only while its person renewed it within this many
 * days (every page of the app renews it while push is on). Short on purpose:
 * someone who lost access to the company cannot renew, so their device stops
 * getting its messages within a week. Signing out ends it at once.
 */
export const DEVICE_VALID_DAYS = 7;
/** Rows not renewed for this long are deleted: they hold a person's id and a device's keys that no longer matter. */
export const DEVICE_FORGET_DAYS = 90;
/** A device whose sends failed this many times in a row is forgotten. */
export const MAX_DEVICE_FAILURES = 10;

/** The push devices of a workspace in the database. */
export function subscriptionStore(db: PrismaClient, now: () => Date = () => new Date()): SubscriptionStore {
  return {
    list: async (workspaceId) => {
      await db.spendingPushSubscription.deleteMany({ where: { authWorkspaceId: workspaceId, renewedAt: { lt: new Date(now().getTime() - DEVICE_FORGET_DAYS * 86_400_000) } } });
      return db.spendingPushSubscription.findMany({
        where: { authWorkspaceId: workspaceId, renewedAt: { gte: new Date(now().getTime() - DEVICE_VALID_DAYS * 86_400_000) } },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      });
    },
    remove: async (id, workspaceId) => {
      await db.spendingPushSubscription.deleteMany({ where: { id, authWorkspaceId: workspaceId } });
    },
    succeeded: async (id, workspaceId) => {
      await db.spendingPushSubscription.updateMany({ where: { id, authWorkspaceId: workspaceId }, data: { failures: 0, lastSuccessAt: now() } });
    },
    failed: async (id, workspaceId) => {
      await db.spendingPushSubscription.updateMany({ where: { id, authWorkspaceId: workspaceId }, data: { failures: { increment: 1 } } });
      await db.spendingPushSubscription.deleteMany({ where: { id, authWorkspaceId: workspaceId, failures: { gte: MAX_DEVICE_FAILURES } } });
    },
  };
}

/** The longest push address accepted: push services use a few hundred characters. */
const MAX_ENDPOINT_LENGTH = 2048;

/** Decoded length of a base64url key, or -1 when it is none. */
function keyLength(key: string, firstByte?: number): number {
  if (!/^[A-Za-z0-9_-]+=*$/.test(key) || key.length > 200) return -1;
  const bytes = Buffer.from(key.replace(/=+$/, ''), 'base64url');
  if (firstByte !== undefined && bytes[0] !== firstByte) return -1;
  return bytes.length;
}

export interface PushContext extends NotifyContext {
  /** The person switching push on: a device belongs to the person who switched it on. */
  userId: string;
}

/**
 * Remember a device that switched push on (the browser's subscription: its
 * push address and two public keys), or renew it. The address must be one of
 * the known push services, the keys must have the sizes browsers make (an
 * uncompressed curve point of 65 bytes, a secret of 16). The same device
 * switching on again replaces its keys and renews it.
 */
/** A browser's subscription, checked: an address of a known push service and keys of the sizes browsers make. */
function checkedSubscription(raw: unknown): { endpoint: string; p256dh: string; auth: string } {
  const input = (raw ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  const p256dh = typeof input.keys?.p256dh === 'string' ? input.keys.p256dh : '';
  const auth = typeof input.keys?.auth === 'string' ? input.keys.auth : '';
  if (endpoint.length > MAX_ENDPOINT_LENGTH || !isPushServiceAddress(endpoint) || keyLength(p256dh, 0x04) !== 65 || keyLength(auth) !== 16) {
    throw new NotifyServiceError('invalid_subscription');
  }
  return { endpoint, p256dh, auth };
}

export async function savePushSubscription(db: PrismaClient, ctx: PushContext, raw: unknown, now: Date = new Date()): Promise<void> {
  const { endpoint, p256dh, auth } = checkedSubscription(raw);
  await db.spendingPushSubscription.upsert({
    where: { authWorkspaceId_endpoint: { authWorkspaceId: ctx.workspaceId, endpoint } },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, userId: ctx.userId, endpoint, p256dh, auth, renewedAt: now },
    update: { userId: ctx.userId, p256dh, auth, failures: 0, renewedAt: now },
  });
}

/**
 * The browser gave this device a new push address on its own (the service
 * worker reports old and new): this person's rows with the old address, in
 * every company, take the new one, so push goes on without anyone noticing.
 * Returns how many rows were moved.
 */
export async function replacePushSubscription(db: PrismaClient, userId: string, oldEndpoint: unknown, raw: unknown, now: Date = new Date()): Promise<number> {
  const next = checkedSubscription(raw);
  if (typeof oldEndpoint !== 'string' || !oldEndpoint) return 0;
  const rows = await db.spendingPushSubscription.findMany({ where: { userId, endpoint: oldEndpoint }, select: { id: true, authWorkspaceId: true } });
  for (const row of rows) {
    // The new address may already be stored for that company (renewed by the page first): then the old row just goes.
    const clash = await db.spendingPushSubscription.findFirst({ where: { authWorkspaceId: row.authWorkspaceId, endpoint: next.endpoint }, select: { id: true } });
    if (clash) await db.spendingPushSubscription.deleteMany({ where: { id: row.id } });
    else await db.spendingPushSubscription.updateMany({ where: { id: row.id }, data: { ...next, failures: 0, renewedAt: now } });
  }
  return rows.length;
}

/** Signing out: this person's device gets nothing more from any company. */
export async function forgetDeviceEverywhere(db: PrismaClient, userId: string, endpoint: unknown): Promise<number> {
  if (typeof endpoint !== 'string' || !endpoint) return 0;
  const { count } = await db.spendingPushSubscription.deleteMany({ where: { userId, endpoint } });
  return count;
}

/** Forget a device for this company (push switched off). Unknown addresses are fine: it is gone either way. */
export async function removePushSubscription(db: PrismaClient, ctx: NotifyContext, endpoint: unknown): Promise<void> {
  if (typeof endpoint !== 'string' || !endpoint) return;
  await db.spendingPushSubscription.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, endpoint } });
}

/** How many devices of the workspace get push (switched on and renewed lately). */
export async function pushDeviceCount(db: PrismaClient, workspaceId: string, now: Date = new Date()): Promise<number> {
  return db.spendingPushSubscription.count({ where: { authWorkspaceId: workspaceId, renewedAt: { gte: new Date(now.getTime() - DEVICE_VALID_DAYS * 86_400_000) } } });
}

/**
 * What the server knows about one device: whether this company has it, and
 * whether other companies of the same person still use it (then switching off
 * here must not end the browser's subscription). Only the person's own rows
 * are looked at, and only a yes or no comes back.
 */
export async function devicePushState(db: PrismaClient, ctx: PushContext, endpoint: unknown): Promise<{ here: boolean; elsewhere: boolean }> {
  if (typeof endpoint !== 'string' || !endpoint) return { here: false, elsewhere: false };
  const rows = await db.spendingPushSubscription.findMany({ where: { endpoint, userId: ctx.userId }, select: { authWorkspaceId: true } });
  return { here: rows.some((r) => r.authWorkspaceId === ctx.workspaceId), elsewhere: rows.some((r) => r.authWorkspaceId !== ctx.workspaceId) };
}

export async function getNotifySettings(db: PrismaClient, workspaceId: string): Promise<NotifySettings> {
  const row = await db.spendingSettings.findUnique({ where: { authWorkspaceId: workspaceId } });
  const channel = row && (CHANNEL_SETTINGS as readonly string[]).includes(row.channel) ? (row.channel as ChannelSetting) : DEFAULT_CHANNEL;
  return { channel, notifyEmail: row?.notifyEmail ?? null };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function saveNotifySettings(db: PrismaClient, ctx: NotifyContext, raw: unknown): Promise<NotifySettings> {
  const input = (raw ?? {}) as { channel?: unknown; notifyEmail?: unknown };
  if (typeof input.channel !== 'string' || !(CHANNEL_SETTINGS as readonly string[]).includes(input.channel)) throw new NotifyServiceError('invalid_channel');
  const email = typeof input.notifyEmail === 'string' ? input.notifyEmail.trim() : '';
  if (email && (email.length > 254 || !EMAIL.test(email))) throw new NotifyServiceError('invalid_email');
  const data = { channel: input.channel, notifyEmail: email || null };
  await db.spendingSettings.upsert({
    where: { authWorkspaceId: ctx.workspaceId },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, ...data },
    update: data,
  });
  return getNotifySettings(db, ctx.workspaceId);
}

async function deliver(db: PrismaClient, id: string, workspaceId: string, message: NotificationMessage, channels: readonly NotificationChannel[]): Promise<void> {
  const settings = await getNotifySettings(db, workspaceId);
  const result = await deliverThroughChannels(channels, settings.channel, { workspaceId, email: settings.notifyEmail }, message);
  if (result.failed && result.channel === null) console.error('[spending] notification not delivered', { subjectKey: message.subjectKey, attempts: result.attempts });
  await db.spendingNotification.updateMany({
    where: { id, authWorkspaceId: workspaceId },
    data: { channel: result.channel, attempts: result.attempts, failed: result.failed && result.channel === null, tries: { increment: 1 } },
  });
}

/**
 * Put a notification into the in-app queue and deliver it. A notification
 * whose subject was notified before (in this workspace) is not sent again:
 * 'duplicate'.
 */
export async function notify(db: PrismaClient, ctx: NotifyContext, message: NotificationMessage, channels: readonly NotificationChannel[] = serverChannels(db)): Promise<'sent' | 'duplicate'> {
  let id: string;
  try {
    // Created as "not delivered yet" (`failed`, no tries): should the run stop
    // before the delivery is recorded, a later run delivers it.
    const row = await db.spendingNotification.create({
      data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, subjectKey: message.subjectKey, kind: message.kind, title: message.title, body: message.body, path: message.path, failed: true },
    });
    id = row.id;
  } catch (e) {
    // Another run created it a moment ago, or long ago: either way it exists once.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return 'duplicate';
    throw e;
  }
  await deliver(db, id, ctx.workspaceId, message, channels);
  return 'sent';
}

/**
 * A notification is only retried once it has been left alone this long: a
 * delivery another run is doing right now is not started a second time.
 */
export const RETRY_AFTER_MS = 60_000;

/** Deliveries retried in one run at most; the rest wait for the next run. */
export const MAX_RETRIES_PER_RUN = 10;

/**
 * Try again the deliveries that failed, or were never recorded because a run
 * stopped halfway (not the merely unavailable ones), the longest waiting
 * first and at most `MAX_RETRIES_PER_RUN`. Each row is claimed before it is
 * sent (its `updatedAt` must still be what was read), so two runs at the same
 * moment never send the same notification twice. Returns how many were tried.
 */
export async function retryFailedDeliveries(
  db: PrismaClient,
  workspaceId: string,
  channels: readonly NotificationChannel[] = serverChannels(db),
  now: Date = new Date(),
): Promise<number> {
  const due = await db.spendingNotification.findMany({
    where: { authWorkspaceId: workspaceId, failed: true, tries: { lt: MAX_DELIVERY_TRIES }, readAt: null, updatedAt: { lt: new Date(now.getTime() - RETRY_AFTER_MS) } },
    orderBy: { updatedAt: 'asc' },
    take: MAX_RETRIES_PER_RUN,
  });
  const failed: typeof due = [];
  for (const n of due) {
    // The claim is stamped with the run's own clock, so a second run on that clock sees it as just claimed.
    const { count } = await db.spendingNotification.updateMany({ where: { id: n.id, authWorkspaceId: workspaceId, updatedAt: n.updatedAt }, data: { updatedAt: now } });
    if (count === 1) failed.push(n);
  }
  for (const n of failed) {
    await deliver(db, n.id, workspaceId, { subjectKey: n.subjectKey, kind: n.kind as NotificationMessage['kind'], title: n.title, body: n.body, path: n.path }, channels);
  }
  return failed.length;
}

export interface NotificationView {
  id: string;
  subjectKey: string;
  kind: string;
  title: string;
  body: string;
  path: string;
  channel: string | null;
  failed: boolean;
  createdAt: string;
}

/** The unread notifications, newest first: the in-app queue. */
export async function listUnreadNotifications(db: PrismaClient, workspaceId: string): Promise<NotificationView[]> {
  const rows = await db.spendingNotification.findMany({ where: { authWorkspaceId: workspaceId, readAt: null }, orderBy: { createdAt: 'desc' }, take: 100 });
  // Not delivered yet (no try recorded) is not shown as a failure.
  return rows.map((n) => ({ id: n.id, subjectKey: n.subjectKey, kind: n.kind, title: n.title, body: n.body, path: n.path, channel: n.channel, failed: n.failed && n.tries > 0, createdAt: n.createdAt.toISOString() }));
}

export async function markNotificationRead(db: PrismaClient, ctx: NotifyContext, id: string): Promise<void> {
  const { count } = await db.spendingNotification.updateMany({ where: { id, authWorkspaceId: ctx.workspaceId, readAt: null }, data: { readAt: new Date() } });
  if (count === 0) {
    const exists = await db.spendingNotification.findFirst({ where: { id, authWorkspaceId: ctx.workspaceId } });
    if (!exists) throw new NotifyServiceError('notification_not_found');
  }
}

/** Notifications whose subject is settled leave the queue by themselves (a receipt arrived, the payment needs none). */
export async function settleNotifications(db: PrismaClient, workspaceId: string, subjectKeys: readonly string[]): Promise<number> {
  if (subjectKeys.length === 0) return 0;
  const { count } = await db.spendingNotification.updateMany({ where: { authWorkspaceId: workspaceId, subjectKey: { in: [...subjectKeys] }, readAt: null }, data: { readAt: new Date() } });
  return count;
}

/**
 * Settle every unread notification of a kind whose subject is not in `stillOpen`:
 * the payment got its receipt, needs none, or is gone (its import was undone).
 * Works from the unread notifications, so it stays small however many payments there are.
 */
export async function settleAllBut(db: PrismaClient, workspaceId: string, kind: NotificationMessage['kind'], stillOpen: ReadonlySet<string>): Promise<number> {
  const unread = await db.spendingNotification.findMany({ where: { authWorkspaceId: workspaceId, kind, readAt: null }, select: { subjectKey: true } });
  return settleNotifications(db, workspaceId, unread.map((n) => n.subjectKey).filter((key) => !stillOpen.has(key)));
}
