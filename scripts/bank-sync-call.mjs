// Signs and sends one call of the daily bank fetch to the app in this container.
// Run through scripts/bank-sync.sh, which provides BANK_SYNC_SECRET. Prints the
// HTTP status and the answer (counts only, never bank data); exits 1 on failure.
import { createHmac } from 'node:crypto';

const secret = process.env.BANK_SYNC_SECRET;
if (!secret) {
  console.error('BANK_SYNC_SECRET is not set');
  process.exit(1);
}
const body = JSON.stringify({ ts: Math.floor(Date.now() / 1000) });
const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
try {
  const res = await fetch('http://localhost:3000/api/internal/bank-sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lumitra-erasure-signature': signature },
    body,
    signal: AbortSignal.timeout(280_000),
  });
  console.log(res.status, await res.text());
  process.exit(res.ok ? 0 : 1);
} catch (e) {
  console.error('bank sync call failed:', e?.name ?? 'error');
  process.exit(1);
}
