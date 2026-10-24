import postgres from 'postgres';
import { assertThrowawayUrl, type ThrowawayDatabase } from './db-guard';
import { ensureContactsLayout } from './contacts-db';

/**
 * Global setup of `pnpm test:db`: every run starts on empty databases. The tests create their own workspaces
 * and never clean up, so a local test database used to grow run after run (2,350 leftover workspaces and
 * 149 MB on one machine, 2026-10) until unrelated tests passed their 30 second limit.
 *
 * Before the first test it empties both throwaway databases, receipts and contacts: every table except the
 * migration bookkeeping is truncated, and the receipts tables the data-table package creates per workspace
 * (`tbl_*`) are dropped, in batches (one transaction for thousands of tables would run out of locks on a
 * database that grew for weeks). The layout stays, so no migration runs again: a reset after a normal run
 * takes about a second, and in continuous integration it truncates tables that are already empty.
 *
 * It only ever touches a database that passes `assertThrowawayUrl` (local host, name ending in `_test`), and
 * then asks the server itself which database it is connected to before it deletes anything. (The server's
 * own address says nothing here: behind Docker's port mapping, locally and in CI, it is the container's.)
 */

/** Tables that record which migrations ran: emptying them would make the next migration run start over. */
const BOOKKEEPING = new Set(['_prisma_migrations', '_migrations']);
/** The per-workspace tables of the data-table package, named after their table id. */
const WORKSPACE_TABLE = /^tbl_[0-9a-f]{32}$/;
/** Tables dropped per transaction: each drop takes a handful of locks, and a transaction may hold only so many. */
const DROP_BATCH = 200;

async function confirmServer(sql: postgres.Sql, target: ThrowawayDatabase, variable: string): Promise<void> {
  const [row] = await sql<{ database: string }[]>`select current_database() as database`;
  if (row.database !== target.database || !row.database.endsWith('_test')) {
    throw new Error(`${variable}: the server reports database "${row.database}"; refusing to empty anything but "${target.database}".`);
  }
}

interface EmptyOptions {
  /** Drop the per-workspace `tbl_*` tables (receipts database). */
  dropWorkspaceTables: boolean;
  /** A table that must exist, or the database was never migrated and the tests could not run anyway. */
  requireMigrations: string | null;
  /** Runs once the server is confirmed, before anything is emptied (applying the contacts layout). */
  prepare?: () => Promise<void>;
}

async function emptyDatabase(target: ThrowawayDatabase, variable: string, options: EmptyOptions) {
  const sql = postgres(target.url, { max: 1, onnotice: () => {} });
  try {
    await confirmServer(sql, target, variable);
    await options.prepare?.();
    const tables = (await sql<{ name: string }[]>`
      select tablename as name from pg_tables where schemaname = 'public' order by tablename`).map((t) => t.name);
    if (options.requireMigrations && !tables.includes(options.requireMigrations)) {
      throw new Error(`${variable}: "${target.database}" has no migrations yet. Run: DATABASE_URL=<this url> pnpm prisma migrate deploy`);
    }
    const workspaceTables = options.dropWorkspaceTables ? tables.filter((t) => WORKSPACE_TABLE.test(t)) : [];
    const rest = tables.filter((t) => !BOOKKEEPING.has(t) && !workspaceTables.includes(t));
    // Dropping is idempotent, so the batches need not be one transaction: a run that stops halfway finishes next time.
    for (let i = 0; i < workspaceTables.length; i += DROP_BATCH) {
      const batch = workspaceTables.slice(i, i + DROP_BATCH);
      await sql.begin(async (tx) => {
        for (const table of batch) await tx.unsafe(`drop table if exists "public"."${table}" cascade`);
      });
    }
    if (rest.length > 0) await sql.unsafe(`truncate ${rest.map((t) => `"public"."${t}"`).join(', ')} restart identity cascade`);
    return { dropped: workspaceTables.length, emptied: rest.length };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export default async function resetTestDatabases(): Promise<void> {
  const receipts = assertThrowawayUrl('TEST_DATABASE_URL', process.env.TEST_DATABASE_URL);
  const contacts = assertThrowawayUrl('CONTACTS_TEST_DATABASE_URL', process.env.CONTACTS_TEST_DATABASE_URL);
  // Everything after this point connects with the URLs the guard rebuilt, including the contacts layout.
  process.env.TEST_DATABASE_URL = receipts.url;
  process.env.CONTACTS_TEST_DATABASE_URL = contacts.url;
  const started = Date.now();
  const r = await emptyDatabase(receipts, 'TEST_DATABASE_URL', { dropWorkspaceTables: true, requireMigrations: '_prisma_migrations' });
  // The contacts layout is the package's own and applied idempotently, so a brand-new database works too.
  const c = await emptyDatabase(contacts, 'CONTACTS_TEST_DATABASE_URL', {
    dropWorkspaceTables: false,
    requireMigrations: null,
    prepare: ensureContactsLayout,
  });
  console.log(
    `test databases emptied in ${Date.now() - started} ms: ${receipts.database} (${r.dropped} workspace tables dropped, ${r.emptied} tables emptied), ` +
      `${contacts.database} (${c.emptied} tables emptied)`,
  );
}
