import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createPushChannel, type SendPush } from '../notify/push';
import {
  DEVICE_FORGET_DAYS,
  DEVICE_VALID_DAYS,
  MAX_DEVICE_FAILURES,
  forgetDeviceEverywhere,
  replacePushSubscription,
  NotifyServiceError,
  devicePushState,
  listUnreadNotifications,
  notify,
  pushDeviceCount,
  removePushSubscription,
  savePushSubscription,
  saveNotifySettings,
  subscriptionStore,
} from '../notify/service';
import type { NotificationChannel, NotificationMessage } from '../notify/port';
import { createWorkspace, db } from '../../../../test/db-helpers';

/**
 * Push subscriptions and delivery against a real database (migration 0029):
 * switching on and off, renewing, forgetting gone and failing devices, the
 * fallback to e-mail, and companies kept apart. Run with `pnpm test:db`.
 * Addresses are invented; keys are made at run time.
 */

const vapid = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:owner@example.com' };
const keys = () => ({ p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'), auth: randomBytes(16).toString('base64url') });
/** Addresses are unique per run: the test database is shared by runs and nothing is cleaned up. */
const RUN = randomBytes(6).toString('hex');
const device = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${RUN}-device-${n}`, keys: keys() });
const message = (key: string): NotificationMessage => ({ subjectKey: key, kind: 'missing_receipt', title: 'Beleg fehlt: Zyx', body: 'Bitte hochladen.', path: '/app/spending' });
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

async function company(userId = 'user-owner') {
  const ws = await createWorkspace();
  return { workspaceId: ws.workspaceId, tenantId: ws.tenantId, userId };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof NotifyServiceError) return e.code;
    throw e;
  }
  return 'no error';
};

afterAll(async () => {
  await db.$disconnect();
});

describe('push devices', () => {
  it('switches on, renews without a second entry, and off', async () => {
    const ctx = await company();
    await savePushSubscription(db, ctx, device(1));
    await savePushSubscription(db, ctx, { ...device(1), keys: keys() });
    expect(await pushDeviceCount(db, ctx.workspaceId)).toBe(1);
    await removePushSubscription(db, ctx, device(1).endpoint);
    await removePushSubscription(db, ctx, `https://fcm.googleapis.com/fcm/send/${RUN}-unknown`);
    expect(await pushDeviceCount(db, ctx.workspaceId)).toBe(0);
  });

  it('refuses anything that is no push subscription of a known push service', async () => {
    const ctx = await company();
    const good = device(1);
    for (const bad of [
      null,
      {},
      { endpoint: 'https://internal.example/hook', keys: good.keys },
      { endpoint: 'http://fcm.googleapis.com/fcm/send/x', keys: good.keys },
      { endpoint: good.endpoint, keys: { p256dh: randomBytes(65).toString('base64url'), auth: good.keys.auth } },
      { endpoint: good.endpoint, keys: { p256dh: good.keys.p256dh, auth: randomBytes(8).toString('base64url') } },
      { endpoint: good.endpoint, keys: { p256dh: 'has spaces', auth: good.keys.auth } },
      { endpoint: good.endpoint },
    ]) {
      expect(await code(savePushSubscription(db, ctx, bad))).toBe('invalid_subscription');
    }
  });

  it('stops sending to a device not renewed within the window, until it is renewed', async () => {
    const ctx = await company();
    await savePushSubscription(db, ctx, device(1), days(-DEVICE_VALID_DAYS - 1));
    expect(await pushDeviceCount(db, ctx.workspaceId)).toBe(0);
    const send = vi.fn<SendPush>(async () => ({ statusCode: 201 }));
    await notify(db, ctx, message('k0'), [createPushChannel(vapid, subscriptionStore(db), send)]);
    expect(send).not.toHaveBeenCalled();
    await savePushSubscription(db, ctx, device(1));
    expect(await pushDeviceCount(db, ctx.workspaceId)).toBe(1);
  });

  it("knows a device per company and person: off in one company leaves the other's", async () => {
    const a = await company('user-owner');
    const b = await company('user-owner');
    const shared = device(7);
    await savePushSubscription(db, a, shared);
    await savePushSubscription(db, b, shared);
    expect(await devicePushState(db, a, shared.endpoint)).toEqual({ here: true, elsewhere: true });
    await removePushSubscription(db, b, shared.endpoint);
    expect(await pushDeviceCount(db, a.workspaceId)).toBe(1);
    expect(await devicePushState(db, a, shared.endpoint)).toEqual({ here: true, elsewhere: false });
    // Another person's rows say nothing about this person's device.
    expect(await devicePushState(db, { ...b, userId: 'user-other' }, shared.endpoint)).toEqual({ here: false, elsewhere: false });
  });
});

describe('a person and their device over time', () => {
  it("moves the person's rows to the device's new address in every company", async () => {
    const a = await company('user-swap');
    const b = await company('user-swap');
    const old = device(20);
    await savePushSubscription(db, a, old);
    await savePushSubscription(db, b, old);
    const next = device(21);
    expect(await replacePushSubscription(db, 'user-swap', old.endpoint, next)).toBe(2);
    expect(await devicePushState(db, a, next.endpoint)).toEqual({ here: true, elsewhere: true });
    expect(await devicePushState(db, a, old.endpoint)).toEqual({ here: false, elsewhere: false });
    // Another person's rows are never moved, and a bad new subscription is refused.
    expect(await replacePushSubscription(db, 'user-other', next.endpoint, device(22))).toBe(0);
    expect(await code(replacePushSubscription(db, 'user-swap', next.endpoint, { endpoint: 'https://internal.example/x', keys: keys() }))).toBe('invalid_subscription');
  });

  it('on a swap to an address a company already holds, the old row just goes', async () => {
    const a = await company('user-clash');
    const old = device(30);
    const next = device(31);
    await savePushSubscription(db, a, old);
    await savePushSubscription(db, a, next);
    await replacePushSubscription(db, 'user-clash', old.endpoint, next);
    expect(await pushDeviceCount(db, a.workspaceId)).toBe(1);
  });

  it('signing out forgets the device for every company of that person only', async () => {
    const a = await company('user-out');
    const b = await company('user-out');
    const other = await company('user-stays');
    const d = device(40);
    await savePushSubscription(db, a, d);
    await savePushSubscription(db, b, d);
    await savePushSubscription(db, other, d);
    expect(await forgetDeviceEverywhere(db, 'user-out', d.endpoint)).toBe(2);
    expect(await pushDeviceCount(db, other.workspaceId)).toBe(1);
  });

  it(`deletes rows not renewed for ${DEVICE_FORGET_DAYS} days`, async () => {
    const ctx = await company();
    await savePushSubscription(db, ctx, device(50), days(-DEVICE_FORGET_DAYS - 1));
    await savePushSubscription(db, ctx, device(51), days(-DEVICE_VALID_DAYS - 1));
    await subscriptionStore(db).list(ctx.workspaceId);
    expect(await db.spendingPushSubscription.count({ where: { authWorkspaceId: ctx.workspaceId } })).toBe(1);
  });
});

describe('delivery', () => {
  it('pushes to the devices of this company only, and forgets a gone one', async () => {
    const a = await company();
    const b = await company();
    await savePushSubscription(db, a, device(1));
    await savePushSubscription(db, a, device(2));
    await savePushSubscription(db, b, device(3));
    const send = vi.fn<SendPush>(async (sub) => {
      if (sub.endpoint.endsWith('device-2')) throw Object.assign(new Error('gone'), { statusCode: 410 });
      return { statusCode: 201 };
    });
    expect(await notify(db, a, message('k1'), [createPushChannel(vapid, subscriptionStore(db), send)])).toBe('sent');
    expect(send.mock.calls.map(([sub]) => sub.endpoint).sort()).toEqual([device(1).endpoint, device(2).endpoint]);
    expect(await pushDeviceCount(db, a.workspaceId)).toBe(1);
    expect(await pushDeviceCount(db, b.workspaceId)).toBe(1);
    expect((await listUnreadNotifications(db, a.workspaceId))[0]).toMatchObject({ channel: 'push' });
  });

  it('falls back to e-mail when no device has push', async () => {
    const ctx = await company();
    await saveNotifySettings(db, ctx, { channel: 'push', notifyEmail: 'owner@example.com' });
    const sentByMail: string[] = [];
    const email: NotificationChannel = {
      name: 'email',
      async send(_r, m) {
        sentByMail.push(m.subjectKey);
        return { status: 'sent' };
      },
    };
    await notify(db, ctx, message('k2'), [createPushChannel(vapid, subscriptionStore(db), vi.fn<SendPush>()), email]);
    expect(sentByMail).toEqual(['k2']);
    expect((await listUnreadNotifications(db, ctx.workspaceId))[0]).toMatchObject({ channel: 'email' });
  });

  it('counts failures in a row, clears them on success, and forgets a device that keeps failing', async () => {
    const ctx = await company();
    await savePushSubscription(db, ctx, device(1));
    let fail = true;
    const send = vi.fn<SendPush>(async () => {
      if (fail) throw Object.assign(new Error('boom'), { statusCode: 500 });
      return { statusCode: 201 };
    });
    const push = createPushChannel(vapid, subscriptionStore(db), send);
    await notify(db, ctx, message('k3'), [push]);
    expect((await db.spendingPushSubscription.findFirst({ where: { authWorkspaceId: ctx.workspaceId } }))?.failures).toBe(1);
    fail = false;
    await notify(db, ctx, message('k4'), [push]);
    const row = await db.spendingPushSubscription.findFirst({ where: { authWorkspaceId: ctx.workspaceId } });
    expect(row?.failures).toBe(0);
    expect(row?.lastSuccessAt).not.toBeNull();
    fail = true;
    for (let i = 0; i < MAX_DEVICE_FAILURES; i++) await notify(db, ctx, message(`f${i}`), [push]);
    expect(await pushDeviceCount(db, ctx.workspaceId)).toBe(0);
  });
});
