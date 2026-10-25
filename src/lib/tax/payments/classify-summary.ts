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
  unavailable: boolean;
  failedBatches: number;
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
  const left = run.pending - decided;
  if (!run.unavailable && run.failedBatches === 0 && left > 0) sentences.push(`${counted(left, 'weitere folgt', 'weitere folgen')} beim nächsten Prüfen.`);
  return sentences.join(' ');
}
