'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import ActionNotice, { type ActionNoticeState } from '@/components/ui/ActionNotice';
import {
  batchOutcomeNotice,
  receiptCount,
  type MealBatchKind,
  type MealBatchNotice,
  type MealBatchResult,
} from '@/lib/meals/batch';
import { mealActionMessage } from '@/lib/meals/messages';
import type { MealRecord } from '@/lib/meals/types';
import type { MealsStore } from '@/stores/MealsStore';
import { deleteMealReceipts, markMealsNotMeal, restoreMeals, type Result } from './actions';

interface PendingConfirm {
  kind: 'not_meal' | 'delete';
  records: MealRecord[];
}

interface UseReceiptActionsOptions {
  /** Where the action shows at once, and where its answer lands. */
  writes: Pick<MealsStore, 'begin' | 'answered' | 'refused' | 'say'>;
  /** Takes the focus when a row leaves with the button that was pressed, until the outcome takes it. */
  focusHome: RefObject<HTMLElement | null>;
  /** Where "Keine Bewirtung" receipts are found again, as it reads from this tab. */
  dismissedHint: string;
  /** Whether this tab keeps a checkbox selection, so a notice may say kept receipts stay selected. */
  hasSelection?: boolean;
}

const ACTIONS: Record<MealBatchKind, (rowIds: string[]) => Promise<Result<MealBatchResult>>> = {
  not_meal: markMealsNotMeal,
  restore: restoreMeals,
  delete: deleteMealReceipts,
};

function label(record: MealRecord): string {
  return record.vendor || record.name || 'Beleg ohne Namen';
}

/**
 * The list actions of the meals page ("Keine Bewirtung", delete, take back),
 * for one receipt or many, with the confirmation dialogs and the notice that
 * reports the outcome.
 *
 * An action shows at once in the store and is sent after that; other rows stay
 * usable while its answer is out. A refusal rolls that record back and goes to the
 * shell, which says it wherever the person is by then. Everything else is
 * reported here, and leaves with this tab.
 */
export function useReceiptActions({ writes, focusHome, dismissedHint, hasSelection = false }: UseReceiptActionsOptions) {
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const seq = useRef(0);

  // Runs after the render that took the row away, and after a closing dialog has handed the focus back to its button.
  const [focusAsked, setFocusAsked] = useState(0);
  useEffect(() => {
    if (focusAsked > 0) focusHome.current?.focus({ preventScroll: true });
  }, [focusAsked, focusHome]);

  /** Show a notice in the dock. Also for an outcome that is not a list action (an edit that moved an entry). */
  const notify = useCallback((n: MealBatchNotice) => {
    seq.current += 1;
    setNotice({ ...n, seq: seq.current });
  }, []);

  const run = useCallback(
    async (kind: MealBatchKind, records: MealRecord[]) => {
      setConfirm(null);
      const write = writes.begin(kind, records.map((r) => r.rowId));
      if (!write) return;
      setFocusAsked((n) => n + 1);
      const single = records.length === 1 ? label(records[0]) : undefined;
      const who = single ?? receiptCount(records.length);
      try {
        const result = await ACTIONS[kind](write.rowIds);
        if (!result.ok) {
          writes.refused(write, who, mealActionMessage(result.error, result.detail));
          return;
        }
        writes.answered(write, result.value);
        const outcome = batchOutcomeNotice(kind, result.value, single, hasSelection);
        if (outcome.tone === 'danger') writes.say(write, who, outcome.text);
        else notify(outcome);
      } catch {
        // A thrown action: the network is down or the server unreachable. Nothing is assumed done.
        writes.refused(write, who, mealActionMessage('failed'));
      }
    },
    [writes, hasSelection, notify],
  );

  /** "Keine Bewirtung". With `confirm`, an in-page dialog names the count first. */
  const markNotMeal = useCallback(
    (records: MealRecord[], options: { confirm: boolean }) => {
      if (records.length === 0) return;
      if (options.confirm) setConfirm({ kind: 'not_meal', records });
      else void run('not_meal', records);
    },
    [run],
  );

  /** Delete for good. Always asks first. */
  const requestDelete = useCallback((records: MealRecord[]) => {
    if (records.length === 0) return;
    setConfirm({ kind: 'delete', records });
  }, []);

  const restore = useCallback((records: MealRecord[]) => void run('restore', records), [run]);

  const count = confirm?.records.length ?? 0;
  const single = count === 1 && confirm ? label(confirm.records[0]) : null;

  const dialogs: ReactNode = (
    <>
      <ConfirmDialog
        open={confirm?.kind === 'not_meal'}
        title={count === 1 ? 'Beleg als „Keine Bewirtung“ führen?' : `${receiptCount(count)} als „Keine Bewirtung“ führen?`}
        confirmLabel="Keine Bewirtung"
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && void run('not_meal', confirm.records)}
      >
        <p>
          {single
            ? `„${single}“ verlässt die offenen Bewirtungen und das Verzeichnis, bleibt aber als normaler Beleg in der Belegliste.`
            : `${receiptCount(count)} verlassen die offenen Bewirtungen und das Verzeichnis, bleiben aber als normale Belege in der Belegliste.`}{' '}
          Bereits erfasste Angaben (Teilnehmer, Anlass, Ort) bleiben gespeichert.
        </p>
        <p className="mt-2">Das lässt sich rückgängig machen: {dismissedHint}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm?.kind === 'delete'}
        title={count === 1 ? 'Beleg endgültig löschen?' : `${receiptCount(count)} endgültig löschen?`}
        confirmLabel={count === 1 ? 'Beleg löschen' : `${receiptCount(count)} löschen`}
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && void run('delete', confirm.records)}
      >
        <p>
          {single
            ? `„${single}“ wird mit der gespeicherten Belegdatei und allen Angaben gelöscht, auch aus der Belegliste.`
            : `${receiptCount(count)} werden mit den gespeicherten Belegdateien und allen Angaben gelöscht, auch aus der Belegliste.`}{' '}
          <strong>Das kann nicht rückgängig gemacht werden.</strong>
        </p>
        <p className="mt-2">
          War es nur keine Bewirtung, der Beleg gehört aber in die Buchhaltung? Dann abbrechen und „Keine Bewirtung“
          wählen.
        </p>
      </ConfirmDialog>
    </>
  );

  const dismissNotice = useCallback(() => setNotice(null), []);

  /** Dialogs and the outcome notice. All of it floats, so where this is rendered does not matter. */
  const overlays: ReactNode = (
    <>
      {dialogs}
      {notice && <ActionNotice key={notice.seq} notice={notice} onDismiss={dismissNotice} />}
    </>
  );

  return { notice, notify, markNotMeal, requestDelete, restore, overlays };
}
