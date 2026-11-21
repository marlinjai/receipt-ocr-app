import 'server-only';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { ErasureEventMismatchError, ErasureLeaseLostError, type ErasureCounts, type ErasureLease, type ErasureLedger } from './erasure';

/**
 * The erasure ledger: the table `erasure_events`, one row per delivery of
 * auth-brain's `tenant.erased` (plan docs/plans/2026-11-21-company-erasure-register.md).
 *
 * It answers, long after the company is gone, "was this company erased here,
 * when, and what did that remove and not remove". Auth-brain keeps only the
 * status of our answer, so the counts live here. Ids, counts and reason codes
 * only. A company erasure never deletes this table's rows.
 *
 * What the counts mean. Every run records what THAT run removed: a completed
 * run its full counts, a failed run its reason and, under `detail.partial`,
 * what it had removed before it stopped. Only one erasure works at a time in
 * the whole app (the lease below), and a stored file an earlier run already
 * removed is counted apart (`storedFilesAlreadyGone`), so the runs of an event
 * add up without counting anything twice. A run that completes records its
 * counts whether or not it still holds the lease at that moment. One case is
 * not recorded: a run whose process died writes nothing, so the sum can be too
 * low, never too high. The status `completed` is what says that the recount
 * found nothing of the company.
 *
 * The lease. A run takes it before it touches anything and renews it between
 * its steps. It is two columns on the event's row (`lease_token`,
 * `lease_until`), not a database lock: holding a lock would keep a database
 * connection open for the whole run, and several erasures arriving together
 * (an organization with several companies is deleted) would each hold one and
 * wait for another until the app has none left. A delivery that finds a lease
 * in force answers 409 and auth-brain tries again later. A lease that is not
 * renewed runs out after `leaseSeconds`, so a run whose process died does not
 * block erasures for good. A run that finds its lease gone stops at its next step.
 *
 * An event id belongs to one company. A delivery that carries a recorded id
 * with another company is refused (`ErasureEventMismatchError`) before anything
 * is erased.
 *
 * Every write is one statement, so two deliveries at the same time cannot lose
 * each other's entry. Lease times are the database's clock, never the app's.
 */

/** The most runs kept per event. Auth-brain sends a delivery at most eight times; a person can send it again. */
const RUNS_KEPT = 50;
/**
 * How long a lease lasts without being renewed. A run renews it between its steps; its longest single
 * step is one database transaction of at most sixty seconds.
 */
export const LEASE_SECONDS = 180;

/** The database's clock as the timestamps of this table are stored (without a time zone, in UTC). */
const NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

export function erasureLedger(db: PrismaClient, options: { now?: () => Date; leaseSeconds?: number } = {}): ErasureLedger {
  const now = options.now ?? (() => new Date());
  const leaseSeconds = options.leaseSeconds ?? LEASE_SECONDS;
  /** Append one run, keeping the newest `RUNS_KEPT`. */
  const appended = (run: Record<string, unknown>) => Prisma.sql`
    (SELECT COALESCE(jsonb_agg(r.value ORDER BY r.ordinality), '[]'::jsonb)
       FROM (SELECT value, ordinality FROM jsonb_array_elements(erasure_events.runs || ${JSON.stringify([run])}::jsonb) WITH ORDINALITY
              ORDER BY ordinality DESC LIMIT ${RUNS_KEPT}) r)`;
  /** Give the lease back, but only when it is still this run's: another run's lease is never touched. */
  const released = (lease: ErasureLease | undefined) => ({
    token: lease ? Prisma.sql`CASE WHEN lease_token = ${lease.token} THEN NULL ELSE lease_token END` : Prisma.sql`lease_token`,
    until: lease ? Prisma.sql`CASE WHEN lease_token = ${lease.token} THEN NULL ELSE lease_until END` : Prisma.sql`lease_until`,
  });

  return {
    async begin(event) {
      const ids = [...new Set(event.workspaceIds)].sort();
      const at = now();
      // The workspace ids are kept per EVENT, not per company: every retry of one delivery carries
      // the same body, and a person who sends an event by hand may send it again with one more workspace.
      // Another event for the same company starts from its own list.
      const rows = await db.$queryRaw<Array<{ workspace_ids: string[] | null }>>`
        INSERT INTO erasure_events (event_id, kind, company_id, workspace_ids, status, attempts, received_at, updated_at)
        VALUES (${event.eventId}, ${event.kind}, ${event.companyId}, ${ids}::text[], 'received', 1, ${at}, ${at})
        ON CONFLICT (event_id) DO UPDATE SET
          attempts = erasure_events.attempts + 1,
          workspace_ids = ARRAY(SELECT DISTINCT unnest(COALESCE(erasure_events.workspace_ids, '{}') || EXCLUDED.workspace_ids) ORDER BY 1),
          updated_at = EXCLUDED.updated_at
        WHERE erasure_events.company_id = EXCLUDED.company_id
        RETURNING workspace_ids`;
      // No row came back: the id exists for another company, and the update did not apply.
      if (rows.length !== 1) throw new ErasureEventMismatchError();
      return { workspaceIds: [...(rows[0].workspace_ids ?? [])].sort() };
    },

    async acquire(eventId) {
      const token = randomUUID();
      // "No lease in force anywhere" and "take it" must be one step, or two deliveries arriving together
      // would both see none. A short transaction serializes the takers; it is over in milliseconds and
      // holds its connection only that long.
      const taken = await db.$transaction(async (tx) => {
        // Cast to text: the function answers nothing, and the client cannot read a column of nothing.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('receipts-erasure-lease', 0))::text AS locked`;
        return tx.$executeRaw`
          UPDATE erasure_events SET lease_token = ${token}, lease_until = ${NOW} + make_interval(secs => ${leaseSeconds})
          WHERE event_id = ${eventId} AND NOT EXISTS (SELECT 1 FROM erasure_events held WHERE held.lease_until > ${NOW})`;
      });
      if (taken !== 1) return null;
      return {
        token,
        async renew() {
          const renewed = await db.$executeRaw`
            UPDATE erasure_events SET lease_until = ${NOW} + make_interval(secs => ${leaseSeconds})
            WHERE event_id = ${eventId} AND lease_token = ${token} AND lease_until > ${NOW}`;
          if (renewed !== 1) throw new ErasureLeaseLostError();
        },
      };
    },

    async busy(eventId) {
      const run = { at: now().toISOString(), outcome: 'busy', reason: 'already_running' };
      // Neither the status nor the lease changes: the run that is at work decides both.
      await db.$executeRaw`UPDATE erasure_events SET updated_at = ${now()}, runs = ${appended(run)} WHERE event_id = ${eventId}`;
    },

    async complete(eventId, counts: ErasureCounts, lease) {
      const at = now();
      const { notErased, ...removed } = counts;
      const run = { at: at.toISOString(), outcome: 'completed', counts: removed, notErased: notErased ?? [] };
      const free = released(lease);
      // Not conditional on the lease: the run did remove what it counts, also when its lease ran out at the end.
      const updated = await db.$executeRaw`
        UPDATE erasure_events SET status = 'completed', completed_at = COALESCE(completed_at, ${at}), updated_at = ${at}, runs = ${appended(run)},
          lease_token = ${free.token}, lease_until = ${free.until}
        WHERE event_id = ${eventId}`;
      if (updated !== 1) throw new Error('erasure ledger: the event to complete is not recorded');
    },

    async release(eventId, lease) {
      await db.$executeRaw`UPDATE erasure_events SET lease_token = NULL, lease_until = NULL WHERE event_id = ${eventId} AND lease_token = ${lease.token}`;
    },

    async fail(eventId, reason, detail, lease) {
      const at = now();
      const run = { at: at.toISOString(), outcome: 'failed', reason, ...(detail ? { detail } : {}) };
      const free = released(lease);
      // A run that fails after an earlier one completed does not undo that completion.
      await db.$executeRaw`
        UPDATE erasure_events SET status = CASE WHEN status = 'completed' THEN status ELSE 'failed' END, updated_at = ${at}, runs = ${appended(run)},
          lease_token = ${free.token}, lease_until = ${free.until}
        WHERE event_id = ${eventId}`;
    },
  };
}
