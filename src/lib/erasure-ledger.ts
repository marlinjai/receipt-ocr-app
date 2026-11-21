import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { ErasureCounts, ErasureLedger } from './erasure';

/**
 * The erasure ledger: the table `erasure_events`, one row per delivery of
 * auth-brain's `tenant.erased` (plan docs/plans/2026-11-21-company-erasure-register.md).
 *
 * It answers, long after the company is gone, "was this company erased here,
 * when, and what did that remove and not remove". Auth-brain keeps only the
 * status of our answer, so the counts live here. Ids, counts and reason codes
 * only. A company erasure never deletes this table's rows.
 *
 * The counts of a run are what THAT run removed. A run that fails part way
 * records its reason and no counts, although it may have removed something
 * (contacts, some stored files) before it stopped; the run that completes then
 * counts only what was left. The sum of the recorded counts is therefore a
 * lower bound of what was removed, and "completed" is what says that nothing
 * of the company was left.
 *
 * Every write is one statement, so two deliveries of the same event at the same
 * time cannot lose each other's entry.
 */

/** The most runs kept per event. Auth-brain sends a delivery at most eight times; a person can send it again. */
const RUNS_KEPT = 50;

export function erasureLedger(db: PrismaClient, now: () => Date = () => new Date()): ErasureLedger {
  /** Append one run, keeping the newest `RUNS_KEPT`. */
  const appended = (run: Record<string, unknown>) => Prisma.sql`
    (SELECT COALESCE(jsonb_agg(r.value ORDER BY r.ordinality), '[]'::jsonb)
       FROM (SELECT value, ordinality FROM jsonb_array_elements(erasure_events.runs || ${JSON.stringify([run])}::jsonb) WITH ORDINALITY
              ORDER BY ordinality DESC LIMIT ${RUNS_KEPT}) r)`;

  return {
    async begin(event) {
      const ids = [...new Set(event.workspaceIds)].sort();
      const at = now();
      await db.$executeRaw`
        INSERT INTO erasure_events (event_id, kind, company_id, workspace_ids, status, attempts, received_at, updated_at)
        VALUES (${event.eventId}, ${event.kind}, ${event.companyId}, ${ids}::text[], 'received', 1, ${at}, ${at})
        ON CONFLICT (event_id) DO UPDATE SET
          attempts = erasure_events.attempts + 1,
          workspace_ids = ARRAY(SELECT DISTINCT unnest(COALESCE(erasure_events.workspace_ids, '{}') || EXCLUDED.workspace_ids) ORDER BY 1),
          updated_at = EXCLUDED.updated_at`;
      // Every workspace any delivery for this company has named: a "send again" that names
      // fewer (or a delivery of another request for the same company) still reaches them.
      const rows = await db.erasureEvent.findMany({ where: { companyId: event.companyId }, select: { workspaceIds: true } });
      return { workspaceIds: [...new Set(rows.flatMap((r) => r.workspaceIds))].sort() };
    },

    async complete(eventId, counts: ErasureCounts) {
      const at = now();
      const { notErased, ...removed } = counts;
      const run = { at: at.toISOString(), outcome: 'completed', counts: removed, notErased: notErased ?? [] };
      const updated = await db.$executeRaw`
        UPDATE erasure_events SET status = 'completed', completed_at = COALESCE(completed_at, ${at}), updated_at = ${at}, runs = ${appended(run)}
        WHERE event_id = ${eventId}`;
      if (updated !== 1) throw new Error('erasure ledger: the event to complete is not recorded');
    },

    async fail(eventId, reason, detail) {
      const at = now();
      const run = { at: at.toISOString(), outcome: 'failed', reason, ...(detail ? { detail } : {}) };
      // A run that fails after an earlier one completed does not undo that completion.
      await db.$executeRaw`
        UPDATE erasure_events SET status = CASE WHEN status = 'completed' THEN status ELSE 'failed' END, updated_at = ${at}, runs = ${appended(run)}
        WHERE event_id = ${eventId}`;
    },
  };
}
