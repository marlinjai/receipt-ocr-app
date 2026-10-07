'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Contact } from '@/lib/contacts/store';
import { mealActionMessage } from '@/lib/meals/messages';
import { mealStatus } from '@/lib/meals/rules';
import { createContact, getMealForRow, saveMeal, type MealForRow } from '@/app/app/meals/actions';
import MealDetailsForm from './MealDetailsForm';

interface MealPanelSectionProps {
  rowId: string;
  /** Called after a save that changed something, so the table can reload the row. */
  onSaved?: () => void;
  /** 'panel' (default) draws its own card and heading; 'sheet' is bare, for the capture bottom sheet. */
  variant?: 'panel' | 'sheet';
  /** A second button beside save, for example "Später" on the capture sheet. */
  secondaryAction?: { label: string; onClick: () => void };
  /** Called once a save leaves the meal complete (the capture sheet closes itself then). */
  onCompleted?: () => void;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: MealForRow };

/** The "Bewirtung" section of the receipt detail panel: loads the meal of one row and shows the form. */
export default function MealPanelSection({
  rowId,
  onSaved,
  variant = 'panel',
  secondaryAction,
  onCompleted,
}: MealPanelSectionProps) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getMealForRow(rowId)
      .then((result) => {
        if (cancelled) return;
        setState(
          result.ok
            ? { kind: 'ready', data: result.value }
            : { kind: 'error', message: mealActionMessage(result.error, result.detail) },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error', message: mealActionMessage('failed') });
      });
    return () => {
      cancelled = true;
    };
  }, [rowId, attempt]);

  const onContactCreated = useCallback((contact: Contact) => {
    setState((s) =>
      s.kind === 'ready' && !s.data.contacts.some((c) => c.id === contact.id)
        ? { kind: 'ready', data: { ...s.data, contacts: [...s.data.contacts, contact] } }
        : s,
    );
  }, []);

  return (
    <div className={variant === 'panel' ? 'rounded-xl border border-gray-800 bg-gray-900 p-4' : undefined} data-theme="dark">
      {variant === 'panel' && (
        <h3 className="mb-4 text-xs font-medium uppercase tracking-wider text-gray-500">Bewirtung</h3>
      )}
      {state.kind === 'loading' && (
        <p className="text-sm" style={{ color: 'var(--muted)' }} role="status">
          Angaben werden geladen…
        </p>
      )}
      {state.kind === 'error' && (
        <div className="ui-note ui-note-danger" role="alert">
          <p>{state.message}</p>
          <button
            type="button"
            className="ui-btn ui-btn-sm mt-2"
            onClick={() => {
              setState({ kind: 'loading' });
              setAttempt((n) => n + 1);
            }}
          >
            Erneut versuchen
          </button>
        </div>
      )}
      {state.kind === 'ready' && (
        <MealDetailsForm
          record={state.data.record}
          contacts={state.data.contacts}
          settings={state.data.settings}
          defaultHost={state.data.defaultHost}
          onSave={saveMeal}
          onCreateContact={createContact}
          onContactCreated={onContactCreated}
          secondaryAction={secondaryAction}
          onSaved={(record, changed) => {
            setState((s) => (s.kind === 'ready' ? { kind: 'ready', data: { ...s.data, record } } : s));
            if (changed) onSaved?.();
            if (mealStatus(record).kind !== 'incomplete') onCompleted?.();
          }}
        />
      )}
    </div>
  );
}
