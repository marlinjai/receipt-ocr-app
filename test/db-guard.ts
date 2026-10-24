/**
 * The one gate every database test passes before it touches a database: the URL must name a throwaway
 * database on this machine. `pnpm test:db` empties these databases before each run (test/db-reset.ts),
 * so this check is what makes it impossible to point the suite at production or any shared database.
 *
 * Allowed: host `localhost` or `127.0.0.1`, a database name ending in `_test`, and nothing in the query that
 * could send the connection elsewhere (`host`, `hostaddr`, `service`). Anything else is refused with the
 * reason and the fix.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const REDIRECTING_PARAMS = new Set(['host', 'hostaddr', 'service']);
/** A plain identifier ending in `_test`, so it can also be checked against `current_database()` as is. */
const TEST_DATABASE_NAME = /^[A-Za-z0-9_]+_test$/;

export interface ThrowawayDatabase {
  url: string;
  /** The database name, as the server must report it back (`current_database()`). */
  database: string;
}

/** Checks a URL; throws a message naming the variable, what is wrong and how to fix it. */
export function assertThrowawayUrl(variable: string, url: string | undefined): ThrowawayDatabase {
  if (!url) {
    throw new Error(
      `${variable} is not set. The database tests need a throwaway local Postgres database whose name ends in ` +
        `"_test" (see README, "Development"). They never run against a shared database.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${variable} is not a valid database URL.`);
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`${variable} must be a postgres:// URL, got "${parsed.protocol}".`);
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`${variable} must point at a database on this machine (localhost or 127.0.0.1), got host "${parsed.hostname}".`);
  }
  for (const key of parsed.searchParams.keys()) {
    if (REDIRECTING_PARAMS.has(key.toLowerCase())) {
      throw new Error(`${variable} must not carry "${key}" in its query: it could send the connection to another server.`);
    }
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!TEST_DATABASE_NAME.test(database)) {
    throw new Error(
      `${variable} must name a database ending in "_test" (letters, digits and underscores), got "${database || '(none)'}". ` +
        `The test run empties it. Create one, for example: createdb -h 127.0.0.1 -U <user> receipts_test`,
    );
  }
  return { url, database };
}
