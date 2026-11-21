import { describe, expect, it } from 'vitest';
import { assertThrowawayUrl } from './db-guard';

/**
 * Run by `pnpm verify` BEFORE it applies the migrations (`pnpm check:databases`).
 *
 * `prisma migrate deploy` writes to whatever `DATABASE_URL` says, and the guard of
 * the database tests only runs later, inside those tests. So a `TEST_DATABASE_URL`
 * set by mistake to a shared database would be migrated before anything refused
 * it. This check refuses first, with the same rules: local host, a name ending in
 * `_test`, no query parameter that redirects the connection.
 */
describe('the databases pnpm verify is about to write to', () => {
  it.each(['TEST_DATABASE_URL', 'CONTACTS_TEST_DATABASE_URL', 'DATABASE_URL'])('%s is a local throwaway database', (variable) => {
    expect(() => assertThrowawayUrl(variable, process.env[variable])).not.toThrow();
  });

  it('the migrations go to the receipts test database and nowhere else', () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
  });
});
