'use client';

import { useMemo, useState } from 'react';
import MealDetailsForm from '@/components/meals/MealDetailsForm';
import ReceiptPreview from '@/components/meals/ReceiptPreview';
import type { Contact } from '@/lib/contacts/store';
import { receiptCount } from '@/lib/meals/batch';
import { DISMISSED_HINT, formatDay, formatEuro } from '@/lib/meals/messages';
import type { IncompleteEntry } from '@/lib/meals/register';
import { MISSING_FIELD_LABELS, mealStatus } from '@/lib/meals/rules';
import { pruneSelection, selectAllState, toggleAll, toggleSelected } from '@/lib/meals/selection';
import type { MealGuestEntry, MealRecord, MealTaxSettings } from '@/lib/meals/types';
import { createContact, saveMeal } from './actions';
import { ActionNotice, useReceiptActions } from './useReceiptActions';

interface QueueTabProps {
  queue: IncompleteEntry[];
  contacts: Contact[];
  settings: MealTaxSettings;
  defaultHost: string;
  onRecordSaved: (record: MealRecord) => void;
  /** Records changed by a list action (now "Keine Bewirtung"). */
  onRecordsSaved: (records: MealRecord[]) => void;
  /** Receipts that no longer exist. */
  onRecordsRemoved: (rowIds: string[]) => void;
  onContactCreated: (contact: Contact) => void;
  onOpenRegister: () => void;
}

function entryLabel(record: MealRecord): string {
  return record.vendor || record.name || 'Beleg ohne Namen';
}

function entryAmount(record: MealRecord): string {
  if (!record.gross) return '';
  if (record.currency === 'EUR') return formatEuro(record.gross);
  if (record.fxRate) return formatEuro(record.gross * record.fxRate);
  return `${record.gross.toFixed(2).replace('.', ',')} ${record.currency}`;
}

/**
 * The work queue: every meal that would be a register entry but lacks facts,
 * oldest first. This one list is the resume path (a half-filled entry is
 * still here after a reload), the re-entry path, and the way the backlog of
 * older receipts gets worked off.
 *
 * Receipts that do not belong here leave without the form: each entry has
 * "Keine Bewirtung" and "Löschen", and checked entries get both as a batch.
 * The opened entry (the form on the right) and the checked entries are two
 * separate things.
 */
export default function QueueTab({
  queue,
  contacts,
  settings,
  defaultHost,
  onRecordSaved,
  onRecordsSaved,
  onRecordsRemoved,
  onContactCreated,
  onOpenRegister,
}: QueueTabProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [previousGuests, setPreviousGuests] = useState<MealGuestEntry[]>([]);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const actions = useReceiptActions({ onRecordsSaved, onRecordsRemoved, dismissedHint: DISMISSED_HINT, hasSelection: true });

  const queueIds = useMemo(() => queue.map((e) => e.record.rowId), [queue]);
  // Derived on every render: an entry that left the queue can never stay checked.
  const checked = useMemo(() => pruneSelection(checkedIds, queueIds), [checkedIds, queueIds]);
  const checkedRecords = useMemo(
    () => queue.filter((e) => checked.has(e.record.rowId)).map((e) => e.record),
    [queue, checked],
  );
  const allState = selectAllState(checked, queueIds);
  const opened = queue.find((e) => e.record.rowId === openId) ?? queue[0] ?? null;
  const busy = actions.busy;

  if (queue.length === 0) {
    return (
      <div className="space-y-4">
        <ActionNotice notice={actions.notice} />
        <div className="glass-panel rounded-xl p-8 text-center">
          <p className="text-base font-medium" style={{ color: 'var(--foreground)' }}>
            Keine offenen Bewirtungen.
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: 'var(--muted)' }}>
            {lastSaved ? `${lastSaved} ` : ''}
            Jeder als Bewirtung kategorisierte Beleg hat Teilnehmer und Anlass. Neue Belege erscheinen hier, sobald
            Angaben fehlen.
          </p>
          <button type="button" className="ui-btn ui-btn-primary mt-4" onClick={onOpenRegister}>
            Zum Verzeichnis
          </button>
        </div>
        {actions.dialogs}
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <div className="min-w-0">
        <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }} role="status">
          {lastSaved ? `${lastSaved} ` : ''}
          {queue.length === 1 ? 'Noch 1 Beleg offen.' : `Noch ${queue.length} Belege offen.`}
        </p>
        <ActionNotice notice={actions.notice} className="mb-2" />

        <label className="mb-2 flex min-h-8 cursor-pointer items-center gap-2 px-1 text-sm" style={{ color: 'var(--foreground)' }}>
          <input
            type="checkbox"
            className="ui-check"
            checked={allState === 'all'}
            ref={(el) => {
              if (el) el.indeterminate = allState === 'some';
            }}
            disabled={busy}
            onChange={() => setCheckedIds(toggleAll(checked, queueIds))}
          />
          Alle auswählen
        </label>

        {/* Always in the page, so a screen reader hears the selection change. */}
        <p className="sr-only" role="status">
          {checked.size > 0 ? `${receiptCount(checked.size)} ausgewählt. Sammelaktionen: Keine Bewirtung oder Löschen.` : ''}
        </p>
        {checked.size > 0 && (
          <div role="group" aria-label="Aktionen für die Auswahl" className="ui-batchbar sticky top-2 z-10 mb-2">
            <p className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
              {checked.size} von {queue.length} ausgewählt
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="ui-btn ui-btn-sm"
                disabled={busy}
                onClick={() => actions.markNotMeal(checkedRecords, { confirm: true })}
              >
                Keine Bewirtung
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-danger"
                disabled={busy}
                onClick={() => actions.requestDelete(checkedRecords)}
              >
                Löschen
              </button>
              <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => setCheckedIds(new Set())}>
                Auswahl aufheben
              </button>
            </div>
          </div>
        )}

        <nav aria-label="Offene Bewirtungen">
          <ul className="max-h-[48svh] space-y-1.5 overflow-y-auto pr-1 lg:max-h-[75svh]">
            {queue.map(({ record, missing }) => {
              const isOpen = opened?.record.rowId === record.rowId;
              const isChecked = checked.has(record.rowId);
              const name = entryLabel(record);
              const spoken = `${name}, ${formatDay(record.date)}`;
              return (
                <li
                  key={record.rowId}
                  className="rounded-lg border transition-colors duration-150"
                  style={{
                    borderColor: isOpen ? 'rgba(226, 163, 72, 0.55)' : 'var(--border)',
                    background: isOpen ? 'var(--accent-muted)' : 'var(--surface)',
                  }}
                >
                  <div className="flex items-start">
                    <label className="flex cursor-pointer items-center self-stretch py-2.5 pl-3 pr-1">
                      <input
                        type="checkbox"
                        className="ui-check"
                        checked={isChecked}
                        disabled={busy}
                        onChange={() => setCheckedIds(toggleSelected(checked, record.rowId))}
                      />
                      <span className="sr-only">{spoken} auswählen</span>
                    </label>
                    <button
                      type="button"
                      aria-current={isOpen ? 'true' : undefined}
                      onClick={() => setOpenId(record.rowId)}
                      className="min-w-0 flex-1 rounded-lg px-2 py-2.5 text-left"
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                          {name}
                        </span>
                        <span className="shrink-0 text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>
                          {entryAmount(record)}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-xs" style={{ color: 'var(--muted)' }}>
                        {formatDay(record.date)} · fehlt: {missing.map((m) => MISSING_FIELD_LABELS[m]).join(', ')}
                      </span>
                    </button>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1.5 px-2 pb-2">
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm"
                      disabled={busy}
                      aria-label={`Keine Bewirtung: ${spoken}`}
                      onClick={() => actions.markNotMeal([record], { confirm: false })}
                    >
                      Keine Bewirtung
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm ui-btn-danger"
                      disabled={busy}
                      aria-label={`Löschen: ${spoken}`}
                      onClick={() => actions.requestDelete([record])}
                    >
                      Löschen
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>

      {opened && (
        <section aria-label="Angaben zur Bewirtung" className="grid min-w-0 gap-6 xl:grid-cols-2">
          <div className="glass-panel rounded-xl p-4 sm:p-5">
            <h2 className="mb-1 text-base font-semibold" style={{ color: 'var(--foreground)' }}>
              {opened.record.name || opened.record.vendor || 'Beleg'}
            </h2>
            <p className="mb-4 text-xs" style={{ color: 'var(--muted)' }}>
              {formatDay(opened.record.date)}
              {opened.record.gross ? ` · ${opened.record.gross.toFixed(2).replace('.', ',')} ${opened.record.currency}` : ''}
              {' · '}Strg oder Cmd + Enter speichert
            </p>
            <MealDetailsForm
              record={opened.record}
              contacts={contacts}
              settings={settings}
              defaultHost={defaultHost}
              previousGuests={previousGuests}
              saveLabel="Speichern und weiter"
              onSave={saveMeal}
              onCreateContact={createContact}
              onContactCreated={onContactCreated}
              onSaved={(record) => {
                if (record.guests.length > 0) setPreviousGuests(record.guests);
                const stillOpen = mealStatus(record).kind === 'incomplete';
                const label = record.vendor || record.name || 'Beleg';
                setLastSaved(stillOpen ? `${label}: gespeichert, noch unvollständig.` : `${label}: gespeichert.`);
                if (!stillOpen) {
                  // Advance to the entry after this one (or the first, at the end).
                  const index = queue.findIndex((e) => e.record.rowId === record.rowId);
                  const next = queue[index + 1] ?? queue.find((e) => e.record.rowId !== record.rowId) ?? null;
                  setOpenId(next ? next.record.rowId : null);
                }
                onRecordSaved(record);
              }}
            />
          </div>
          <div className="xl:sticky xl:top-4 xl:self-start">
            <ReceiptPreview key={opened.record.rowId} files={opened.record.files} />
          </div>
        </section>
      )}
      {actions.dialogs}
    </div>
  );
}
