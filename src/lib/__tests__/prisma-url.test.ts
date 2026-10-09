import { describe, expect, it } from 'vitest';
import { withoutStatementCache } from '../prisma-url';

describe('withoutStatementCache', () => {
  it('turns the prepared-statement cache off and keeps the rest of the address', () => {
    const url = withoutStatementCache('postgresql://receipts:p%40ss@db.internal:5432/receipts?schema=public');
    const parsed = new URL(url!);
    expect(parsed.searchParams.get('statement_cache_size')).toBe('0');
    expect(parsed.searchParams.get('schema')).toBe('public');
    expect(parsed.hostname).toBe('db.internal');
    expect(parsed.port).toBe('5432');
    expect(parsed.pathname).toBe('/receipts');
    expect(parsed.username).toBe('receipts');
    expect(parsed.password).toBe('p%40ss');
  });

  it('overrides a cache size that is already set', () => {
    const url = withoutStatementCache('postgresql://u:p@localhost:5432/db?statement_cache_size=500');
    expect(new URL(url!).searchParams.getAll('statement_cache_size')).toEqual(['0']);
  });

  it('leaves a missing or unreadable address for Prisma to report', () => {
    expect(withoutStatementCache(undefined)).toBeUndefined();
    expect(withoutStatementCache('')).toBe('');
    expect(withoutStatementCache('not a url')).toBe('not a url');
  });
});
