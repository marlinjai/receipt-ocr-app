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
import { createPushChannel } from './push';

/**
 * Notifications of one workspace: the in-app queue, the setting, and delivery
 * through the port. Every read and write is scoped to the workspace passed in.
 */

export interface NotifyContext {
  workspaceId: string;
  tenantId: string | null;
}

export type NotifyServiceErrorCode = 'invalid_channel' | 'invalid_email' | 'notification_not_found';

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

/** The channels the server offers: push first, then e-mail. Each says by itself when it cannot deliver. */
export function serverChannels(): NotificationChannel[] {
  return [createPushChannel(), createEmailChannel(emailConfigFromEnv())];
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
export async function notify(db: PrismaClient, ctx: NotifyContext, message: NotificationMessage, channels: readonly NotificationChannel[] = serverChannels()): Promise<'sent' | 'duplicate'> {
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
  channels: readonly NotificationChannel[] = serverChannels(),
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
