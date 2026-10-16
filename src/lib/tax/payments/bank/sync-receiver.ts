import { verifyErasureSignature } from '@/lib/erasure-signature';

/**
 * The daily run of the bank feed, as a machine caller sees it. Authenticated
 * by a Hash-based Message Authentication Code (HMAC) over the raw body with
 * BANK_SYNC_SECRET, using the header and the verifier of the erasure webhook.
 * The body is `{"ts": <unix seconds>}` and must be at most five minutes old,
 * so a signed request seen once (in a proxy log) cannot be replayed later to
 * use up the few unattended fetches a bank allows per day. It fails closed:
 * without the secret, or with the feed switched off, nothing runs. The answer
 * carries counts per connection, never bank data.
 */

/** How far the signed time may lie from the server's clock, either way. */
export const SYNC_SIGNATURE_WINDOW_SECONDS = 300;
export interface SyncDelivery {
  status: number;
  body: Record<string, unknown>;
}

export async function receiveBankSync(input: {
  rawBody: string;
  signature: string | null | undefined;
  secret: string | null | undefined;
  /** False when the feed is switched off or its settings are incomplete. */
  enabled: boolean;
  sync: () => Promise<Array<{ connectionId: string; status: string; added: number }>>;
  log?: (line: string) => void;
  now?: () => Date;
}): Promise<SyncDelivery> {
  const log = input.log ?? ((line: string) => console.log(line));
  if (!input.secret) {
    log('[bank] sync secret not configured, refusing the call');
    return { status: 503, body: { error: 'Service misconfigured' } };
  }
  if (!verifyErasureSignature(input.rawBody, input.signature, input.secret)) {
    return { status: 401, body: { error: 'Invalid signature' } };
  }
  let ts: unknown;
  try {
    ts = (JSON.parse(input.rawBody) as { ts?: unknown })?.ts;
  } catch {
    ts = undefined;
  }
  const nowSeconds = Math.floor((input.now ?? (() => new Date()))().getTime() / 1000);
  if (typeof ts !== 'number' || !Number.isFinite(ts) || Math.abs(nowSeconds - ts) > SYNC_SIGNATURE_WINDOW_SECONDS) {
    return { status: 401, body: { error: 'Stale or missing timestamp' } };
  }
  if (!input.enabled) {
    log('[bank] bank feed is switched off, nothing synced');
    return { status: 503, body: { error: 'Bank feed is off' } };
  }
  try {
    const results = await input.sync();
    const added = results.reduce((sum, r) => sum + r.added, 0);
    const failed = results.filter((r) => r.status === 'failed').length;
    log(`[bank] synced ${results.length} connections, ${added} new payments, ${failed} failed`);
    return { status: 200, body: { ok: true, connections: results.length, added, failed, results } };
  } catch (e) {
    log(`[bank] sync run failed (${(e as Error)?.name ?? 'error'})`);
    return { status: 502, body: { error: 'Sync failed; will retry' } };
  }
}
