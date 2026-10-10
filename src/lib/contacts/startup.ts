import 'server-only';
import { migrate, type ContactsDb } from '@marlinjai/contacts-core';
import { contactsDb } from './db';

export type ContactsStartupOutcome = 'ready' | 'unreachable';

/**
 * Runs once when the server starts (src/instrumentation.ts), before it serves.
 * The shared contacts database is the only contact store, so this always runs.
 *
 * - Not configured (`CONTACTS_DATABASE_URL` missing): the error propagates and
 *   the start stops. There is no other store to fall back to, so a server that
 *   started anyway would fail on every contact request instead.
 * - Database unreachable: logged and the server starts anyway. The contact tab
 *   and the guest picker show an error with a retry, and the meal register and
 *   its exports keep working from the printed copies. The layout is applied at
 *   the next start, once the database answers.
 * - Migration fails (a checksum differs, or a change cannot be applied): the
 *   error propagates and the start stops. Serving against a layout this build
 *   does not understand is worse than not serving.
 *
 * Only the failed connection is treated as degraded. The log lines carry the
 * error's name, never its message, because a connection error can echo the host.
 */
export async function runContactsStartup(
  deps: { handle?: ContactsDb; log?: (line: string) => void } = {},
): Promise<ContactsStartupOutcome> {
  const handle = deps.handle ?? contactsDb();
  const log = deps.log ?? ((line: string) => console.log(line));

  try {
    await handle.sql`SELECT 1`;
  } catch (e) {
    log(`[contacts] database unreachable at start (${(e as Error)?.name ?? 'error'}), continuing in degraded mode`);
    return 'unreachable';
  }

  await migrate(handle.sql, { log: (line) => log(`[contacts] ${line}`) });
  return 'ready';
}
