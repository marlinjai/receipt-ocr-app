/**
 * What a run of the app deciding counterparties did, in German (plan
 * docs/plans/2026-10-25-auto-classify-payments.md). Pure and free of server
 * code, so the pages that show it can import it.
 */

/** What one run of deciding counterparties did, as `classify-service.ts` reports it. */
export interface ClassifyRunCounts {
  pending: number;
  byEvidence: number;
  byModel: number;
  applied: number;
  /** Asked, but the model gave no usable answer for them: stored as such, not asked again until their evidence changes. */
  unanswered: number;
  /** A verdict the receipts made removed because they no longer agree. */
  removed: number;
  unavailable: boolean;
  failedBatches: number;
  /** The run stopped starting new calls at its time limit; the rest follows on the next run. */
  stoppedEarly: boolean;
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** True when the run decided nothing although the model was asked and failed: the page shows it as a failure, not a notice. */
export function classifyFailed(run: ClassifyRunCounts | null): boolean {
  return run === null || (run.failedBatches > 0 && run.byEvidence + run.byModel === 0);
}

/** What a run did, for the page that started it; empty when there was nothing to decide. */
export function classifySummary(run: ClassifyRunCounts | null): string {
  if (run === null) return 'Die Gegenseiten konnten nicht eingeordnet werden; bitte gleich noch einmal versuchen.';
  const decided = run.byEvidence + run.byModel;
  const sentences: string[] = [];
  if (decided > 0) {
    sentences.push(`Die App hat ${counted(decided, 'Gegenseite', 'Gegenseiten')} eingeordnet, ${run.applied === decided ? 'alle sicher' : `davon ${run.applied} sicher; die übrigen sind Vorschläge`}.`);
  }
  if (run.unavailable && run.pending > run.byEvidence) {
    sentences.push('Ohne Sprachmodell auf dem Server ordnet die App nur ein, was zugeordnete Belege eindeutig sagen.');
  }
  if (run.failedBatches > 0) {
    sentences.push(
      decided > 0
        ? 'Ein Teil konnte gerade nicht eingeordnet werden; beim nächsten Prüfen wird es wieder versucht.'
        : 'Die Gegenseiten konnten gerade nicht eingeordnet werden; beim nächsten Prüfen wird es wieder versucht.',
    );
  }
  if (run.unanswered > 0) sentences.push(`Zu ${counted(run.unanswered, 'Gegenseite', 'Gegenseiten')} kam keine verwertbare Antwort; sie bleiben offen.`);
  const left = run.pending - decided - run.unanswered;
  if (!run.unavailable && run.failedBatches === 0 && left > 0) sentences.push(`${counted(left, 'weitere folgt', 'weitere folgen')} beim nächsten Prüfen.`);
  return sentences.join(' ');
}
