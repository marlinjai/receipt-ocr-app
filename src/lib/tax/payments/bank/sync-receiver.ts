import { verifyErasureSignature } from '@/lib/erasure-signature';

/**
 * The daily run of the bank feed, as a machine caller sees it. Authenticated
 * by HMAC over the raw body with BANK_SYNC_SECRET, using the header and the
 * verifier of the erasure webhook. It fails closed: without the secret, or
 * with the feed switched off, nothing runs. The answer carries counts per
 * connection, never bank data.
 */
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
}): Promise<SyncDelivery> {
  const log = input.log ?? ((line: string) => console.log(line));
  if (!input.secret) {
    log('[bank] sync secret not configured, refusing the call');
    return { status: 503, body: { error: 'Service misconfigured' } };
  }
  if (!verifyErasureSignature(input.rawBody, input.signature, input.secret)) {
    return { status: 401, body: { error: 'Invalid signature' } };
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
