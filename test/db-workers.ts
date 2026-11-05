import postgres from 'postgres';
import { assertThrowawayUrl, type ThrowawayDatabase } from './db-guard';

/**
 * One database per test worker, so the database test files run side by side without sharing a row or a table.
 *
 * Why: the data-table adapter finds a row by asking every row table of the whole database in turn
 * (`PrismaAdapter.getRow`, also behind `updateRow`, `archiveRow` and `deleteRow`). With all files in one
 * database, every workspace an earlier file created made each later row lookup slower, so a file's time
 * depended on which files ran before it, and on a loaded machine the late files passed their limit. Each
 * worker now gets its own copy of the migrated test database, and every file starts that copy empty
 * (test/db-setup.ts), so a file only ever meets the tables it created itself.
 *
 * The copies are made by the global setup (test/db-reset.ts) from the two databases the run was given,
 * `<name>_test` becoming `<name>_w<n>_test`, and each passes the same guard as the original.
 */

/**
 * Test files that run at once. The ceiling is Postgres connections, not cores: per worker the tests' own
 * Prisma client and the app's client hold at most `PRISMA_CONNECTIONS` each, plus one connection that empties
 * the copy before a file. 4 x (2 x 8 + 1) = 68, under the default `max_connections` of 100 that the service
 * container in continuous integration runs with. The contacts database is a second server with its own limit.
 */
export const DB_TEST_WORKERS = 4;

/** Connections per Prisma client in a test worker (Prisma's own default is cores x 2 + 1: 29 on a 14-core Mac). */
export const PRISMA_CONNECTIONS = 8;

/** The copy of a throwaway database that one worker uses. Checked by the guard like the original. */
export function workerDatabase(variable: string, original: ThrowawayDatabase, worker: number): ThrowawayDatabase {
  if (!Number.isInteger(worker) || worker < 1 || worker > DB_TEST_WORKERS) {
    throw new Error(`${variable}: worker ${worker} has no database; workers are numbered 1 to ${DB_TEST_WORKERS}.`);
  }
  const url = new URL(original.url);
  url.pathname = `/${original.database.replace(/_test$/, '')}_w${worker}_test`;
  return assertThrowawayUrl(`${variable} (worker ${worker})`, url.toString());
}

/** The worker this file runs in, as vitest numbers it (`VITEST_POOL_ID`, 1 to `DB_TEST_WORKERS`). */
export function currentWorker(): number {
  const raw = process.env.VITEST_POOL_ID;
  const worker = Number(raw);
  if (!raw || !Number.isInteger(worker)) {
    throw new Error(`VITEST_POOL_ID is "${raw ?? ''}": the database tests run only under vitest (pnpm test:db).`);
  }
  return worker;
}

/** A Prisma URL with the connection ceiling of a test worker (Prisma reads `connection_limit`, Postgres never sees it). */
export function withConnectionLimit(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', String(PRISMA_CONNECTIONS));
  return parsed.toString();
}

/**
 * Replaces every worker copy of `original` with a fresh copy of it. Runs once per run, after the original was
 * emptied and every connection to it closed: Postgres copies a database only while nobody is connected to it.
 * Copies left by an earlier run with more workers are dropped too, so none lingers.
 */
export async function cloneForWorkers(variable: string, original: ThrowawayDatabase): Promise<string[]> {
  // CREATE and DROP DATABASE run from the server's maintenance database; this connection touches nothing else.
  const maintenance = new URL(original.url);
  maintenance.pathname = '/postgres';
  const sql = postgres(maintenance.toString(), { max: 1, onnotice: () => {} });
  const stem = original.database.replace(/_test$/, '');
  const copies = Array.from({ length: DB_TEST_WORKERS }, (_, i) => workerDatabase(variable, original, i + 1).database);
  try {
    const existing = (await sql<{ name: string }[]>`select datname as name from pg_database`).map((d) => d.name);
    const stale = existing.filter((name) => new RegExp(`^${stem}_w[0-9]+_test$`).test(name));
    for (const name of stale) await sql.unsafe(`drop database if exists "${name}" with (force)`);
    for (const name of copies) {
      try {
        await sql.unsafe(`create database "${name}" template "${original.database}"`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${variable}: could not copy "${original.database}" to "${name}" (${reason}). The user needs the right to create ` +
            `databases, and nothing else may be connected to "${original.database}" while the run starts.`,
        );
      }
    }
    return copies;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
