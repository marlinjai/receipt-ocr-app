import { describe, expect, it } from 'vitest';
import { runOrder } from '../service';

const at = (iso: string | null) => (iso === null ? null : new Date(iso));
const c = (id: string, lastAttemptedAt: string | null, createdAt: string) => ({ id, lastAttemptedAt: at(lastAttemptedAt), createdAt: new Date(createdAt) });

describe('the order of a daily run', () => {
  it('starts with the connection never tried, then the one tried longest ago, then the older one', () => {
    const order = runOrder([
      c('tried-today', '2026-10-20T06:30:00Z', '2026-01-01T00:00:00Z'),
      c('tried-last-week', '2026-10-13T06:30:00Z', '2026-05-01T00:00:00Z'),
      c('never', null, '2026-10-19T00:00:00Z'),
      c('never-older', null, '2026-02-01T00:00:00Z'),
    ]).map((x) => x.id);
    expect(order).toEqual(['never-older', 'never', 'tried-last-week', 'tried-today']);
  });

  it('a bank that failed yesterday goes behind one that has not been tried since', () => {
    // Both were tried; the failing one again yesterday, the other three days ago.
    const order = runOrder([c('failing', '2026-10-19T06:30:00Z', '2026-01-01T00:00:00Z'), c('quiet', '2026-10-17T06:30:00Z', '2026-06-01T00:00:00Z')]).map((x) => x.id);
    expect(order).toEqual(['quiet', 'failing']);
  });
});
