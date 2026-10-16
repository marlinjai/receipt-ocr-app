'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { enablePush, forgetPushEverywhere, pushStateOfDevice } from './loop-actions';
import { browserPushEnvironment, currentSubscription, switchPushOff, type PushEnvironment } from './push-device';

/**
 * Push and the signed-in person, on every page of the app.
 *
 * `PushRenewal`: while push is on for the active company on this device, each
 * page renews it, so the server knows the device is still in use (a device
 * not renewed for a week gets nothing more: someone who lost access cannot
 * renew). `SignOutLink`: signing out first switches push off on this device
 * for every company of this person, then goes to the sign-out address.
 */

export async function renewPush(env: PushEnvironment, deps = { pushStateOfDevice, enablePush }): Promise<boolean> {
  const current = await currentSubscription(env);
  if (!current) return false;
  const state = await deps.pushStateOfDevice(current.endpoint);
  if (!state.ok || !state.value.here) return false;
  const renewed = await deps.enablePush(current.json);
  return renewed.ok;
}

export function PushRenewal({ environment }: { environment?: PushEnvironment | null }) {
  useEffect(() => {
    const env = environment === undefined ? browserPushEnvironment() : environment;
    if (!env) return;
    // A renewal that fails is retried on the next page; nothing to show for it.
    void renewPush(env).catch(() => false);
  }, [environment]);
  return null;
}

export async function signOutWithPush(env: PushEnvironment | null, logoutUrl: string, go: (url: string) => void, deps = { forgetPushEverywhere }): Promise<void> {
  try {
    if (env) {
      const current = await currentSubscription(env);
      if (current) {
        await deps.forgetPushEverywhere(current.endpoint);
        await switchPushOff(env, false);
      }
    }
  } catch (e) {
    // Signing out never waits on push: the device is forgotten within a week anyway.
    console.warn('[push] could not switch push off before signing out', e);
  }
  go(logoutUrl);
}

export function SignOutLink({ href, title, children, environment }: { href: string; title?: string; children: ReactNode; environment?: PushEnvironment | null }) {
  const [busy, setBusy] = useState(false);
  return (
    <a
      href={href}
      title={title}
      aria-busy={busy}
      className="text-xs transition-colors hover:underline"
      style={{ color: 'var(--muted)' }}
      onClick={(e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        void signOutWithPush(environment === undefined ? browserPushEnvironment() : environment, href, (url) => window.location.assign(url));
      }}
    >
      {children}
    </a>
  );
}
