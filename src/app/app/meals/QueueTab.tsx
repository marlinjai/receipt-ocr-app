'use client';

import { useState } from 'react';
import MealDetailsForm from '@/components/meals/MealDetailsForm';
import ReceiptPreview from '@/components/meals/ReceiptPreview';
import type { Contact } from '@/lib/contacts/store';
import { formatDay, formatEuro } from '@/lib/meals/messages';
import type { IncompleteEntry } from '@/lib/meals/register';
import { MISSING_FIELD_LABELS, mealStatus } from '@/lib/meals/rules';
import type { MealGuestEntry, MealRecord, MealTaxSettings } from '@/lib/meals/types';
import { createContact, saveMeal } from './actions';

interface QueueTabProps {
  queue: IncompleteEntry[];
  contacts: Contact[];
  settings: MealTaxSettings;
  defaultHost: string;
  onRecordSaved: (record: MealRecord) => void;
  onContactCreated: (contact: Contact) => void;
  onOpenRegister: () => void;
}

/**
 * The work queue: every meal that would be a register entry but lacks facts,
 * oldest first. This one list is the resume path (a half-filled entry is
 * still here after a reload), the re-entry path, and the way the backlog of
 * older receipts gets worked off.
 */
export default function QueueTab({
  queue,
  contacts,
  settings,
  defaultHost,
  onRecordSaved,
  onContactCreated,
  onOpenRegister,
}: QueueTabProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previousGuests, setPreviousGuests] = useState<MealGuestEntry[]>([]);
  const [lastSaved, setLastSaved] = useState<string | null>(null);

  const selected = queue.find((e) => e.record.rowId === selectedId) ?? queue[0] ?? null;

  if (queue.length === 0) {
    return (
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
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <nav aria-label="Offene Bewirtungen">
        <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }} role="status">
          {lastSaved ? `${lastSaved} ` : ''}
          {queue.length === 1 ? 'Noch 1 Beleg offen.' : `Noch ${queue.length} Belege offen.`}
        </p>
        <ul className="max-h-[40svh] space-y-1.5 overflow-y-auto pr-1 lg:max-h-[75svh]">
          {queue.map(({ record, missing }) => {
            const isSelected = selected?.record.rowId === record.rowId;
            return (
              <li key={record.rowId}>
                <button
                  type="button"
                  aria-current={isSelected ? 'true' : undefined}
                  onClick={() => setSelectedId(record.rowId)}
                  className="w-full rounded-lg border px-3 py-2.5 text-left transition-colors duration-150"
                  style={{
                    borderColor: isSelected ? 'rgba(226, 163, 72, 0.55)' : 'var(--border)',
                    background: isSelected ? 'var(--accent-muted)' : 'var(--surface)',
                  }}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                      {record.vendor || record.name || 'Beleg ohne Namen'}
                    </span>
                    <span className="shrink-0 text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>
                      {record.gross ? formatEuro(record.gross * (record.currency === 'EUR' ? 1 : (record.fxRate ?? 1))) : ''}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs" style={{ color: 'var(--muted)' }}>
                    {formatDay(record.date)} · fehlt: {missing.map((m) => MISSING_FIELD_LABELS[m]).join(', ')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {selected && (
        <section aria-label="Angaben zur Bewirtung" className="grid gap-6 xl:grid-cols-2">
          <div className="glass-panel rounded-xl p-4 sm:p-5">
            <h2 className="mb-1 text-base font-semibold" style={{ color: 'var(--foreground)' }}>
              {selected.record.name || selected.record.vendor || 'Beleg'}
            </h2>
            <p className="mb-4 text-xs" style={{ color: 'var(--muted)' }}>
              {formatDay(selected.record.date)}
              {selected.record.gross ? ` · ${selected.record.gross.toFixed(2).replace('.', ',')} ${selected.record.currency}` : ''}
              {' · '}Strg oder Cmd + Enter speichert
            </p>
            <MealDetailsForm
              record={selected.record}
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
                  setSelectedId(next ? next.record.rowId : null);
                }
                onRecordSaved(record);
              }}
            />
          </div>
          <div>
            <ReceiptPreview key={selected.record.rowId} files={selected.record.files} />
          </div>
        </section>
      )}
    </div>
  );
}
