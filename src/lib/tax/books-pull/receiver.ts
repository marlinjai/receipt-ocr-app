import { verifyErasureSignature } from '@/lib/erasure-signature';
import type { BooksPullOutcome } from './service';

/**
 * The scheduled pull from the Books, as a machine caller sees it
 * (`/api/internal/books-pull`). Authenticated like the daily bank fetch: a
 * Hash-based Message Authentication Code (HMAC) over the raw body with
 * BOOKS_PULL_SECRET, the body `{"ts": <unix seconds>}` at most five minutes
 * old and later than every call accepted before (a signed request runs once).
 * It fails closed: without the secret nothing runs.
 *
 * The answer carries counts and invoice numbers only, never a company or a
 * figure. Anything but a landed pull answers non-2xx, so the scheduled task
 * shows a failed run.
 */

export const PULL_SIGNATURE_WINDOW_SECONDS = 300;

export interface PullDelivery {
  status: number;
  body: Record<string, unknown>;
}

export async function receiveBooksPull(input: {
  rawBody: string;
  signature: string | null | undefined;
  secret: string | null | undefined;
  claim: (ts: number) => Promise<boolean>;
  pull: () => Promise<BooksPullOutcome>;
  now?: () => Date;
  log?: (line: string) => void;
}): Promise<PullDelivery> {
  const log = input.log ?? ((line: string) => console.log(line));
  if (!input.secret) {
    log('[books-pull] pull secret not configured, refusing the call');
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
  if (typeof ts !== 'number' || !Number.isInteger(ts) || Math.abs(nowSeconds - ts) > PULL_SIGNATURE_WINDOW_SECONDS) {
    return { status: 401, body: { error: 'Stale or missing timestamp' } };
  }
  if (!(await input.claim(ts))) {
    return { status: 409, body: { error: 'Already run for this request' } };
  }
  let outcome: BooksPullOutcome;
  try {
    outcome = await input.pull();
  } catch (e) {
    log(`[books-pull] pull run failed (${(e as Error)?.name ?? 'error'})`);
    return { status: 502, body: { error: 'Pull failed; will retry' } };
  }
  if (!outcome.ok) {
    return { status: outcome.code === 'not_configured' ? 503 : 502, body: { error: 'Pull failed', code: outcome.code } };
  }
  const r = outcome.report;
  return {
    status: 200,
    body: {
      ok: true,
      created: r.created,
      attached: r.attached,
      updated: r.updated,
      unchanged: r.unchanged,
      paymentsMoved: r.paymentsMoved,
      skipped: r.skipped,
      conflicts: r.conflicts,
    },
  };
}
