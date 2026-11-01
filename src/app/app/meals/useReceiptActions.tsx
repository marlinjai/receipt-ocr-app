'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';
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
import { deleteMealReceipts, markMealsNotMeal, restoreMeals, type Result } from './actions';

interface PendingConfirm {
  kind: 'not_meal' | 'delete';
  records: MealRecord[];
}

interface UseReceiptActionsOptions {
  /** Records the server changed (now "Keine Bewirtung", or taken back). */
  onRecordsSaved: (records: MealRecord[]) => void;
  /** Row ids that no longer exist: deleted now, or found gone by the server. */
  onRecordsRemoved: (rowIds: string[]) => void;
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
 * Only one action runs at a time: a second click while one is in flight is
 * dropped (the lock is a ref, so two clicks in the same tick cannot both
 * pass), and `busy` lets the caller disable its buttons meanwhile.
 */
export function useReceiptActions({ onRecordsSaved, onRecordsRemoved, dismissedHint, hasSelection = false }: UseReceiptActionsOptions) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const inFlight = useRef(false);
  const seq = useRef(0);

  /** Show a notice in the dock. Also for an outcome that is not a list action (an edit that moved an entry). */
  const notify = useCallback((n: MealBatchNotice) => {
    seq.current += 1;
    setNotice({ ...n, seq: seq.current });
  }, []);

  const run = useCallback(
    async (kind: MealBatchKind, records: MealRecord[]) => {
      if (inFlight.current || records.length === 0) return;
      inFlight.current = true;
      setBusy(true);
      try {
        const result = await ACTIONS[kind](records.map((r) => r.rowId));
        if (!result.ok) {
          notify({ tone: 'danger', text: mealActionMessage(result.error, result.detail) });
          return;
        }
        const value = result.value;
        const gone = value.skipped.filter((s) => s.reason === 'not_found').map((s) => s.rowId);
        if (kind === 'delete') {
          onRecordsRemoved([...value.done, ...gone]);
        } else {
          if (value.records.length > 0) onRecordsSaved(value.records);
          if (gone.length > 0) onRecordsRemoved(gone);
        }
        notify(batchOutcomeNotice(kind, value, records.length === 1 ? label(records[0]) : undefined, hasSelection));
      } catch {
        // A thrown action: the network is down or the server unreachable. Nothing is assumed done.
        notify({ tone: 'danger', text: mealActionMessage('failed') });
      } finally {
        inFlight.current = false;
        setBusy(false);
        setConfirm(null);
      }
    },
    [onRecordsSaved, onRecordsRemoved, hasSelection, notify],
  );

  /** "Keine Bewirtung". With `confirm`, an in-page dialog names the count first. */
  const markNotMeal = useCallback(
    (records: MealRecord[], options: { confirm: boolean }) => {
      if (inFlight.current || records.length === 0) return;
      if (options.confirm) setConfirm({ kind: 'not_meal', records });
      else void run('not_meal', records);
    },
    [run],
  );

  /** Delete for good. Always asks first. */
  const requestDelete = useCallback((records: MealRecord[]) => {
    if (inFlight.current || records.length === 0) return;
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
        busy={busy}
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
        busy={busy}
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

  return { busy, notice, notify, markNotMeal, requestDelete, restore, overlays };
}
