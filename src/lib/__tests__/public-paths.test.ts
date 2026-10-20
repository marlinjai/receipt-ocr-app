import { describe, expect, it } from 'vitest';
import { PUBLIC_PATHS } from '../public-paths';

describe('the paths reachable without a session', () => {
  it('include the bank return, which checks the session itself, and the signed daily run', () => {
    expect(PUBLIC_PATHS).toContain('/api/banking/callback');
    expect(PUBLIC_PATHS).toContain('/api/internal/bank-sync');
  });

  it('never include a page of the app or a data route', () => {
    for (const path of PUBLIC_PATHS) {
      expect(path.startsWith('/app')).toBe(false);
      expect(['/api/files', '/api/ocr', '/api/spending', '/api/meals'].some((p) => path.startsWith(p))).toBe(false);
    }
  });
});
