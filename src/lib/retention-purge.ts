import { verifyErasureSignature } from './erasure-signature';

/**
 * The scheduled purge of held printed guest copies (see erasure.ts). A machine
 * caller, so it is authenticated by HMAC over the raw body, like the erasure
 * webhook, with its own secret. It fails closed: no secret, no purge.
 */
export interface PurgeDelivery {
  status: number;
  body: Record<string, unknown>;
}

export async function receiveRetentionPurge(input: {
  rawBody: string;
  signature: string | null | undefined;
  secret: string | undefined;
  purge: () => Promise<number>;
  log?: (line: string) => void;
}): Promise<PurgeDelivery> {
  const log = input.log ?? ((line: string) => console.log(line));
  if (!input.secret) {
    log('[retention] purge secret not configured, refusing the call');
    return { status: 503, body: { error: 'Service misconfigured' } };
  }
  if (!verifyErasureSignature(input.rawBody, input.signature, input.secret)) {
    return { status: 401, body: { error: 'Invalid signature' } };
  }
  try {
    const removed = await input.purge();
    log(`[retention] purged ${removed} held guest copies past their retention date`);
    return { status: 200, body: { ok: true, removed } };
  } catch (e) {
    log(`[retention] purge failed (${(e as Error)?.name ?? 'error'})`);
    return { status: 502, body: { error: 'Purge failed; will retry' } };
  }
}
