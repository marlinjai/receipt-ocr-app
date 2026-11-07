// Signs and sends one scheduled pull from the Books to the app in this container.
// Run through scripts/books-pull.sh, which provides BOOKS_PULL_SECRET. Prints the
// HTTP status and the answer (counts and invoice numbers only); exits 1 on failure.
import { createHmac } from 'node:crypto';

const secret = process.env.BOOKS_PULL_SECRET;
if (!secret) {
  console.error('BOOKS_PULL_SECRET is not set');
  process.exit(1);
}
const body = JSON.stringify({ ts: Math.floor(Date.now() / 1000) });
const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
try {
  const res = await fetch('http://localhost:3000/api/internal/books-pull', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lumitra-erasure-signature': signature },
    body,
    signal: AbortSignal.timeout(110_000),
  });
  console.log(res.status, await res.text());
  process.exit(res.ok ? 0 : 1);
} catch (e) {
  console.error('books pull call failed:', e?.name ?? 'error');
  process.exit(1);
}
