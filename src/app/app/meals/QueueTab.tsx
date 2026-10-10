'use client';

import { useMemo, useState } from 'react';
import Checkbox from '@/components/ui/Checkbox';
import type { Contact } from '@/lib/contacts/store';
import { receiptCount } from '@/lib/meals/batch';
import { DISMISSED_HINT, formatDay, formatEuro, missingList, missingSummary } from '@/lib/meals/messages';
import type { IncompleteEntry } from '@/lib/meals/register';
import { mealStatus } from '@/lib/meals/rules';
import { pruneSelection, selectAllState, toggleAll, toggleSelected } from '@/lib/meals/selection';
import type { MealGuestEntry, MealRecord, MealTaxSettings } from '@/lib/meals/types';
import MealEditor from './MealEditor';
import { useReceiptActions } from './useReceiptActions';

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

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" className="shrink-0" aria-hidden="true" focusable="false">
      <path
        d="M2.75 4.25h10.5M6.25 4.25V3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75v1.25M4.25 4.25l.5 8.3a1 1 0 0 0 1 .95h4.5a1 1 0 0 0 1-.95l.5-8.3M6.75 7v3.75M9.25 7v3.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
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
 *
 * Nothing in the list changes size or position when an entry is checked: the
 * batch bar has a reserved slot at the foot of the queue column, the outcome
 * of an action floats in the dock, and every row is a fixed grid.
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
  // The host typed on one receipt is offered on the next, even before anything was saved.
  const [sessionHost, setSessionHost] = useState('');
  const actions = useReceiptActions({ onRecordsSaved, onRecordsRemoved, dismissedHint: DISMISSED_HINT });

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
      <div className="glass-panel rounded-xl px-6 py-12 text-center">
        <p className="text-base font-medium" style={{ color: 'var(--foreground)' }}>
          Keine offenen Bewirtungen.
        </p>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
          {lastSaved ? `${lastSaved} ` : ''}
          Jeder als Bewirtung kategorisierte Beleg hat Teilnehmer und Anlass. Neue Belege erscheinen hier, sobald
          Angaben fehlen.
        </p>
        <button type="button" className="ui-btn ui-btn-primary mt-5" onClick={onOpenRegister}>
          Zum Verzeichnis
        </button>
        {actions.overlays}
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
      <div className="min-w-0 lg:sticky lg:top-4">
        {/* One fixed-height line: what it says changes, its size does not. */}
        <div className="mb-2 flex h-10 items-center justify-between gap-3">
          <Checkbox
            className="-ml-[0.6875rem]"
            checked={allState === 'all'}
            indeterminate={allState === 'some'}
            disabled={busy}
            onChange={() => setCheckedIds(toggleAll(checked, queueIds))}
            label="Alle auswählen"
          />
          <p
            className="min-w-0 truncate text-xs tabular-nums"
            style={{ color: checked.size > 0 ? 'var(--accent)' : 'var(--muted)' }}
            role="status"
          >
            {checked.size > 0
              ? `${checked.size} von ${queue.length} ausgewählt`
              : `${lastSaved ? `${lastSaved} ` : ''}${queue.length === 1 ? 'Noch 1 Beleg offen.' : `Noch ${queue.length} Belege offen.`}`}
          </p>
        </div>

        {/* Always in the page, so a screen reader hears the selection change. */}
        <p className="sr-only" role="status">
          {checked.size > 0 ? `${receiptCount(checked.size)} ausgewählt. Sammelaktionen: Keine Bewirtung oder Löschen.` : ''}
        </p>

        <nav aria-label="Offene Bewirtungen">
          <ul className="ui-scroll max-h-[46svh] space-y-1.5 pr-1 lg:max-h-[calc(100svh-9rem)]">
            {queue.map(({ record, missing }) => {
              const isOpen = opened?.record.rowId === record.rowId;
              const isChecked = checked.has(record.rowId);
              const name = entryLabel(record);
              const spoken = `${name}, ${formatDay(record.date)}`;
              return (
                <li key={record.rowId} className="ui-row" data-open={isOpen} data-checked={isChecked}>
                  <Checkbox
                    className="ui-row-above row-span-2 self-center"
                    checked={isChecked}
                    disabled={busy}
                    onChange={() => setCheckedIds(toggleSelected(checked, record.rowId))}
                    label={`${spoken} auswählen`}
                    hideLabel
                  />
                  <button
                    type="button"
                    aria-current={isOpen ? 'true' : undefined}
                    onClick={() => setOpenId(record.rowId)}
                    className="ui-row-open flex min-w-0 items-baseline justify-between gap-3 pb-0.5 pr-3 pt-2.5"
                  >
                    <span className="truncate text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                      {name}
                    </span>
                    <span className="shrink-0 text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>
                      {entryAmount(record)}
                    </span>
                  </button>
                  <div className="flex min-w-0 items-center justify-between gap-2 pb-1.5 pr-1.5">
                    <span className="min-w-0 truncate text-xs" style={{ color: 'var(--muted)' }} title={`fehlt: ${missingList(missing)}`}>
                      {formatDay(record.date)} ·{' '}
                      {missing.length > 2 ? (
                        <>
                          {missing.length} fehlen
                          <span className="sr-only">: {missingList(missing)}</span>
                        </>
                      ) : (
                        missingSummary(missing)
                      )}
                    </span>
                    <span className="ui-row-above flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        className="ui-btn ui-btn-sm ui-btn-ghost px-2 text-xs"
                        disabled={busy}
                        aria-label={`Keine Bewirtung: ${spoken}`}
                        onClick={() => actions.markNotMeal([record], { confirm: false })}
                      >
                        Keine Bewirtung
                      </button>
                      <button
                        type="button"
                        className="ui-btn ui-btn-sm ui-btn-ghost ui-btn-danger ui-btn-icon"
                        disabled={busy}
                        aria-label={`Löschen: ${spoken}`}
                        title="Löschen"
                        onClick={() => actions.requestDelete([record])}
                      >
                        <TrashIcon />
                      </button>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </nav>

        {/*
          The batch bar's place. On a desktop it is a slot of fixed height at
          the foot of the queue column, there whether or not anything is
          checked, so the bar appearing moves nothing and can never lie on top
          of a field of the form. On a phone the bar is fixed to the bottom
          edge at full width, and the page keeps that much padding below.
        */}
        <div className="ui-batchbar-slot" data-batch-slot>
          {checked.size > 0 && (
            <div role="group" aria-label="Aktionen für die Auswahl" className="ui-dock-card ui-batchbar flex items-center gap-1.5 py-1.5 pl-3 pr-1.5">
              <p className="mr-auto flex items-center gap-2 pr-2 text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                <span className="ui-count">{checked.size}</span>
                <span className="sr-only">von {queue.length}</span>
                <span className="max-[400px]:sr-only lg:sr-only">ausgewählt</span>
              </p>
              <button
                type="button"
                className="ui-btn ui-btn-sm whitespace-nowrap"
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
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-ghost ui-btn-icon"
                disabled={busy}
                aria-label="Auswahl aufheben"
                title="Auswahl aufheben"
                onClick={() => setCheckedIds(new Set())}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                  <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>

      {opened && (
        <MealEditor
          record={opened.record}
          contacts={contacts}
          settings={settings}
          defaultHost={sessionHost || defaultHost}
          onHostEntered={setSessionHost}
          previousGuests={previousGuests}
          saveLabel="Speichern und weiter"
          onContactCreated={onContactCreated}
          onRecordsSaved={onRecordsSaved}
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
      )}

      {actions.overlays}
    </div>
  );
}
