/**
 * The one gate every database test passes before it touches a database: the URL must name a throwaway
 * database on this machine. `pnpm test:db` empties these databases before each run (test/db-reset.ts),
 * so this check is what makes it impossible to point the suite at production or any shared database.
 *
 * Allowed: exactly one host, written `localhost` or `127.0.0.1` (other loopback spellings such as `[::1]`
 * are refused, which fails safe); a database name ending in `_test`; and in the query only parameters that
 * cannot change where the connection goes or what it writes to (`ALLOWED_PARAMS`). Anything else is refused
 * with the reason and the fix.
 *
 * Database clients do not all read a URL the same way (postgres.js splits the user part at the first `@`
 * and reads commas as a list of hosts; the URL standard splits at the last `@`). So the guard does not hand
 * the URL it was given back: it returns a URL rebuilt from the parts it checked, and the caller connects with
 * that one. Before emptying anything the reset also asks the server for `current_database()`.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
/** Query parameters that only tune a connection. Everything else (database, user, options, schema, host, ...) is refused. */
const ALLOWED_PARAMS = new Set(['sslmode', 'connect_timeout', 'application_name']);
/** A plain identifier ending in `_test`, so it can also be checked against `current_database()` as is. */
const TEST_DATABASE_NAME = /^[A-Za-z0-9_]+_test$/;

export interface ThrowawayDatabase {
  /** The URL rebuilt from the checked parts: connect with this one, never with the one that was passed in. */
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
  // The part between "://" and the path, read as plainly as any client could read it.
  const authority = /^[a-z]+:\/\/([^/?#]*)/i.exec(url)?.[1] ?? '';
  if (authority.includes(',') || (authority.match(/@/g)?.length ?? 0) > 1) {
    throw new Error(`${variable} must name exactly one host and at most one "user@" part; clients read such a URL differently.`);
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
    throw new Error(
      `${variable} must point at a database on this machine, written "localhost" or "127.0.0.1", got host "${parsed.hostname || '(none)'}".`,
    );
  }
  for (const key of parsed.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      throw new Error(
        `${variable} must not carry "${key}" in its query: only ${[...ALLOWED_PARAMS].join(', ')} are allowed, ` +
          `because other parameters can change the server, database, user or schema the tests write to.`,
      );
    }
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!TEST_DATABASE_NAME.test(database)) {
    throw new Error(
      `${variable} must name a database ending in "_test" (letters, digits and underscores), got "${database || '(none)'}". ` +
        `The test run empties it. Create one, for example: createdb -h 127.0.0.1 -U <user> receipts_test`,
    );
  }
  const clean = new URL(`postgresql://${parsed.hostname}`);
  clean.port = parsed.port;
  clean.username = parsed.username;
  clean.password = parsed.password;
  clean.pathname = `/${database}`;
  for (const [key, value] of parsed.searchParams) clean.searchParams.set(key, value);
  return { url: clean.toString(), database };
}
