// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('./loop-actions', () => ({}));
vi.mock('../actions', () => ({ processReceipt: vi.fn() }));
vi.mock('../workspace-actions', () => ({ switchWorkspace: vi.fn() }));
vi.mock('@/lib/upload/browser-deps', () => ({ createBrowserDeps: () => ({}) }));

import { currentSubscription, keyBytes, pushSwitchMessage, switchPushOff, switchPushOn, type PushEnvironment, type SubscriptionLike } from './push-device';
import { PushSwitch, type PushActions } from './ReceiptChecks';

afterEach(cleanup);

function environment(o: { existing?: boolean; permission?: NotificationPermission; noRegistration?: boolean; subscribeFails?: boolean } = {}) {
  let current: SubscriptionLike | null = null;
  const unsubscribe = vi.fn(async () => {
    current = null;
    return true;
  });
  const make = (): SubscriptionLike => ({
    endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe,
  });
  if (o.existing) current = make();
  const subscribe = vi.fn(async () => {
    if (o.subscribeFails) throw new Error('AbortError');
    return (current = make());
  });
  const order: string[] = [];
  const env: PushEnvironment = {
    registration: async () => {
      order.push('registration');
      return o.noRegistration ? null : { pushManager: { getSubscription: async () => current, subscribe } };
    },
    requestPermission: vi.fn(async () => {
      order.push('permission');
      return o.permission ?? 'granted';
    }),
  };
  return { env, subscribe, unsubscribe, order };
}

const actions = (o: Partial<{ enable: boolean; disable: boolean; here: boolean; elsewhere: boolean }> = {}) => {
  const enable = vi.fn(async () => o.enable ?? true);
  const disable = vi.fn(async () => o.disable ?? true);
  const stateOf = vi.fn(async () => ({ here: o.here ?? false, elsewhere: o.elsewhere ?? false }));
  return { enable, disable, stateOf } satisfies PushActions;
};

describe('switching push on this device', () => {
  it('asks for permission before anything else, then subscribes with the server key', async () => {
    const { env, subscribe, order } = environment();
    const result = await switchPushOn(env, 'BAEC');
    expect(order).toEqual(['permission', 'registration']);
    expect(result).toEqual({ ok: true, subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', keys: { p256dh: 'p', auth: 'a' } }, endpoint: 'https://fcm.googleapis.com/fcm/send/device-1' });
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: keyBytes('BAEC') });
  });

  it('tells a denial, a dismissed question, a worker that is not running and a failed subscription apart', async () => {
    expect(await switchPushOn(environment({ permission: 'denied' }).env, 'BAEC')).toEqual({ ok: false, reason: 'denied' });
    expect(await switchPushOn(environment({ permission: 'default' }).env, 'BAEC')).toEqual({ ok: false, reason: 'dismissed' });
    expect(await switchPushOn(environment({ noRegistration: true }).env, 'BAEC')).toEqual({ ok: false, reason: 'no_worker' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await switchPushOn(environment({ subscribeFails: true }).env, 'BAEC')).toEqual({ ok: false, reason: 'failed' });
    warn.mockRestore();
  });

  it('ends the browser subscription only when no other company still uses it', async () => {
    const shared = environment({ existing: true });
    expect(await switchPushOff(shared.env, true)).toBe('https://fcm.googleapis.com/fcm/send/device-1');
    expect(shared.unsubscribe).not.toHaveBeenCalled();
    const alone = environment({ existing: true });
    await switchPushOff(alone.env, false);
    expect(alone.unsubscribe).toHaveBeenCalled();
    expect(await currentSubscription(alone.env)).toBeNull();
    expect(await switchPushOff(alone.env, false)).toBeNull();
  });

  it('turns the base64url server key into its bytes', () => {
    expect(Array.from(keyBytes('AQID'))).toEqual([1, 2, 3]);
    expect(Array.from(keyBytes('-_8'))).toEqual([251, 255]);
  });

  it('says what to do in German, without the browser error', () => {
    expect(pushSwitchMessage({ ok: false, reason: 'unsupported' })).toMatch(/Home-Bildschirm/);
    expect(pushSwitchMessage({ ok: false, reason: 'denied' })).toMatch(/Einstellungen des Geräts/);
    expect(pushSwitchMessage({ ok: false, reason: 'dismissed' })).toMatch(/noch einmal tippen/);
    expect(pushSwitchMessage({ ok: false, reason: 'no_worker' })).toMatch(/neu laden/);
    expect(pushSwitchMessage({ ok: false, reason: 'failed' })).toBe('Push ließ sich nicht einschalten. Bitte noch einmal versuchen.');
  });
});

describe('PushSwitch', () => {
  it('says push is not set up on the server when there is no key, and points to the channel otherwise', () => {
    render(<PushSwitch publicKey={null} devices={0} channel="push" actions={actions()} error={null} environment={null} />);
    expect(screen.getByText(/auf dem Server noch nicht eingerichtet/)).toBeTruthy();
    cleanup();
    render(<PushSwitch publicKey="BAEC" devices={0} channel="email" actions={actions()} error={null} environment={null} />);
    expect(screen.getByText(/nur benutzt, wenn oben/)).toBeTruthy();
  });

  it('counts as on only once the server stored it', async () => {
    const a = actions();
    const { env } = environment();
    render(<PushSwitch publicKey="BAEC" devices={0} channel="push" actions={a} error={null} environment={env} />);
    const button = await screen.findByRole('button', { name: 'Push auf diesem Gerät einschalten' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await userEvent.setup().click(button);
    expect(a.enable).toHaveBeenCalledWith({ endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', keys: { p256dh: 'p', auth: 'a' } });
    expect(await screen.findByRole('button', { name: 'Push auf diesem Gerät ausschalten' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Push ist auf diesem Gerät eingeschaltet.');
  });

  it('takes the browser subscription back when the server refuses it', async () => {
    const a = actions({ enable: false });
    const { env, unsubscribe } = environment();
    render(<PushSwitch publicKey="BAEC" devices={0} channel="push" actions={a} error={null} environment={env} />);
    const button = await screen.findByRole('button', { name: 'Push auf diesem Gerät einschalten' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await userEvent.setup().click(button);
    await waitFor(() => expect(unsubscribe).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Push auf diesem Gerät einschalten' })).toBeTruthy();
    expect(screen.queryByText('Push ist auf diesem Gerät eingeschaltet.')).toBeNull();
  });

  it('shows on only for the company the server holds it for (renewing is the layout\'s job)', async () => {
    const elsewhereOnly = actions({ here: false, elsewhere: true });
    render(<PushSwitch publicKey="BAEC" devices={0} channel="push" actions={elsewhereOnly} error={null} environment={environment({ existing: true }).env} />);
    expect(await screen.findByRole('button', { name: 'Push auf diesem Gerät einschalten' })).toBeTruthy();
    expect(elsewhereOnly.enable).not.toHaveBeenCalled();
    cleanup();
    const here = actions({ here: true });
    render(<PushSwitch publicKey="BAEC" devices={1} channel="push" actions={here} error={null} environment={environment({ existing: true }).env} />);
    expect(await screen.findByRole('button', { name: 'Push auf diesem Gerät ausschalten' })).toBeTruthy();
    expect(here.enable).not.toHaveBeenCalled();
  });

  it('ends nothing when the server cannot say whether another company uses the device', async () => {
    const a = { ...actions({ here: true }), stateOf: vi.fn().mockResolvedValueOnce({ here: true, elsewhere: false }).mockResolvedValue(null) };
    const { env, unsubscribe } = environment({ existing: true });
    render(<PushSwitch publicKey="BAEC" devices={1} channel="push" actions={a} error={null} environment={env} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Push auf diesem Gerät ausschalten' }));
    expect(await screen.findByText(/der Server antwortet gerade nicht/)).toBeTruthy();
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(a.disable).not.toHaveBeenCalled();
  });

  it('switches off here, keeping the browser subscription another company still uses', async () => {
    const a = actions({ here: true, elsewhere: true });
    const { env, unsubscribe } = environment({ existing: true });
    render(<PushSwitch publicKey="BAEC" devices={1} channel="push" actions={a} error={null} environment={env} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Push auf diesem Gerät ausschalten' }));
    expect(a.disable).toHaveBeenCalledWith('https://fcm.googleapis.com/fcm/send/device-1');
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Push auf diesem Gerät einschalten' })).toBeTruthy();
  });

  it('explains a device that offers no push, under a label', () => {
    render(<PushSwitch publicKey="BAEC" devices={0} channel="push" actions={actions()} error={null} environment={null} />);
    expect(screen.getByRole('group', { name: 'Push auf diesem Gerät' })).toBeTruthy();
    expect(screen.getByText(/bietet kein Push/)).toBeTruthy();
  });
});
