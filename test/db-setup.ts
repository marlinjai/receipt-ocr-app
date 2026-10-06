/**
 * Setup for `pnpm test:db`. Fails loudly when no test database is configured,
 * and refuses anything that does not look like a local throwaway database.
 */
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error(
    'TEST_DATABASE_URL is not set. The database tests need a throwaway Postgres with the migrations applied ' +
      '(DATABASE_URL=$TEST_DATABASE_URL pnpm prisma migrate deploy). They never run against a shared database.',
  );
}
const host = new URL(url).hostname;
if (host !== '127.0.0.1' && host !== 'localhost') {
  throw new Error(`TEST_DATABASE_URL must point at a local database, got host "${host}".`);
}
process.env.DATABASE_URL = url;
