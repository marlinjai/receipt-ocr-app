'use client';

import { useId, useState } from 'react';
import type { ReviewEntry } from '@/lib/review/service';
import type { ReadingChange, ReadingField } from '@/lib/review/reading';
import { REASON_TEXT, type ReviewReason } from '@/lib/review/reasons';

/**
 * "Belege prüfen": the receipts that need a person's eye, each with the
 * reasons in plain words and the one or two things that can be done about it.
 *
 * The list is the server's: it is worked out from the stored receipts on
 * every load, so a warning does not depend on the page that first showed it.
 * A look-alike found on the upload page is here again after that page was
 * left, until someone decides.
 */

export interface ReviewPanelProps {
  entries: ReviewEntry[];
  /** True while an action of this panel is running: its buttons are disabled. */
  busy: boolean;
  /** Set when the list could not be loaded or an action failed. */
  error: string | null;
  onOpen: (rowId: string) => void;
  onConfirm: (rowId: string) => void;
  onKeepBoth: (rowId: string, otherRowId: string) => void;
  onDelete: (rowId: string) => void;
  /** Take the offered new reading of a receipt, for the fields named. */
  onTakeReading: (rowId: string, fields: ReadingField[]) => void;
}

const SHORT: Record<ReviewReason, string> = {
  read_failed: 'Nicht lesbar',
  amount_missing: 'Betrag fehlt',
  date_missing: 'Datum fehlt',
  vendor_missing: 'Händler fehlt',
  tax_implausible: 'Steuer prüfen',
  not_classified: 'Nicht eingeordnet',
  total_unconfirmed: 'Betrag prüfen',
  total_conflict: 'Betrag prüfen',
  category_doubt: 'Kategorie prüfen',
  possible_duplicate: 'Mögliches Duplikat',
  reading_differs: 'Neue Lesart',
};

const FIELD_LABEL: Record<ReadingField, string> = {
  name: 'Name',
  vendor: 'Händler',
  gross: 'Gesamtbetrag',
  net: 'Netto',
  taxRate: 'Steuersatz',
  currency: 'Währung',
  tip: 'Trinkgeld',
  category: 'Kategorie',
};

function shown(change: ReadingChange, value: string | number | null, currency: string): string {
  if (value === null || value === '') return 'leer';
  if (typeof value === 'string') return value;
  if (change.field === 'taxRate') return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 }).format(value)} %`;
  return amount(value, currency);
}

/**
 * The currency the newly read amounts are in: the one the reading offers, else
 * the stored one. A total read in dollars is shown in dollars, next to the
 * stored one in the currency the row holds now.
 */
function readCurrency(entry: ReviewEntry): string {
  const offered = entry.proposal.find((c) => c.field === 'currency')?.to;
  return typeof offered === 'string' ? offered : entry.currency;
}

function day(iso: string | null): string {
  if (!iso) return 'ohne Datum';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/**
 * An amount in its currency. The currency is the NAME of a select option, which a
 * person can rename to something that is no currency code ("Euro"): the amount is
 * then shown with that name behind it instead of the list failing to draw.
 */
function amount(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(value);
  } catch {
    return `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} ${currency}`;
  }
}

function money(value: number | null, currency: string): string {
  return value === null ? 'ohne Betrag' : amount(value, currency);
}

export default function ReviewPanel({ entries, busy, error, onOpen, onConfirm, onKeepBoth, onDelete, onTakeReading }: ReviewPanelProps) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  if (entries.length === 0 && !error) return null;

  const count = entries.length;
  return (
    <section
      aria-labelledby={`${panelId}-title`}
      className="mx-4 mt-3 rounded-xl"
      style={{ border: '1px solid rgba(226, 163, 72, 0.28)', background: 'rgba(226, 163, 72, 0.05)' }}
    >
      <h2 id={`${panelId}-title`} className="m-0">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm font-medium"
          style={{ color: 'var(--foreground)' }}
          aria-expanded={open}
          aria-controls={`${panelId}-list`}
          onClick={() => setOpen((v) => !v)}
        >
          <span>
            Belege prüfen
            <span className="ui-count ml-2" aria-hidden="true">
              {count}
            </span>
            <span className="sr-only">: {count === 1 ? '1 Beleg braucht' : `${count} Belege brauchen`} einen Blick</span>
          </span>
          <span className="text-xs" style={{ color: 'var(--dt-text-secondary)' }}>
            {open ? 'Schließen' : 'Anzeigen'}
          </span>
        </button>
      </h2>

      {error && (
        <p role="alert" className="ui-note ui-note-danger mx-4 mb-3">
          {error}
        </p>
      )}

      {open && (
        <ul id={`${panelId}-list`} className="ui-scroll m-0 max-h-[60vh] list-none space-y-2 overflow-y-auto px-4 pb-4">
          {entries.map((entry) => (
            <li key={entry.rowId} className="rounded-lg p-3" style={{ background: 'rgba(10, 10, 15, 0.55)', border: '1px solid var(--border)' }}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="m-0 min-w-0 truncate text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                  {entry.name}
                </p>
                <p className="m-0 shrink-0 text-xs tabular-nums" style={{ color: 'var(--dt-text-secondary)' }}>
                  {day(entry.date)} · {money(entry.gross, entry.currency)}
                </p>
              </div>
              <ul className="m-0 mt-2 list-none space-y-1 p-0">
                {entry.reasons.map((reason) => (
                  <li key={reason} className="flex items-start gap-2 text-xs" style={{ color: 'var(--dt-text-secondary)' }}>
                    <span className="ui-chip shrink-0">{SHORT[reason]}</span>
                    <span>{REASON_TEXT[reason]}</span>
                  </li>
                ))}
              </ul>

              {entry.proposal.length > 0 && (
                <div className="mt-2 rounded-md px-2.5 py-2" style={{ background: 'rgba(255, 255, 255, 0.03)' }}>
                  <table className="w-full text-left text-xs">
                    <caption className="sr-only">Neue Lesart von {entry.name}</caption>
                    <thead>
                      <tr style={{ color: 'var(--dt-text-secondary)' }}>
                        <th scope="col" className="py-1 pr-3 font-normal">
                          Feld
                        </th>
                        <th scope="col" className="py-1 pr-3 font-normal">
                          Gespeichert
                        </th>
                        <th scope="col" className="py-1 font-normal">
                          Neu gelesen
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {entry.proposal.map((change) => (
                        <tr key={change.field}>
                          <th scope="row" className="py-1 pr-3 font-normal" style={{ color: 'var(--dt-text-secondary)' }}>
                            {FIELD_LABEL[change.field]}
                          </th>
                          <td className="py-1 pr-3 tabular-nums line-through decoration-1" style={{ color: 'var(--dt-text-secondary)' }}>
                            {shown(change, change.from, entry.currency)}
                          </td>
                          <td className="py-1 tabular-nums" style={{ color: 'var(--foreground)' }}>
                            {shown(change, change.to, readCurrency(entry))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm mt-2"
                    disabled={busy}
                    onClick={() => onTakeReading(entry.rowId, entry.proposal.map((c) => c.field))}
                  >
                    Neue Lesart übernehmen
                  </button>
                </div>
              )}

              {entry.duplicates.map((other) => (
                <div key={other.rowId} className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md px-2.5 py-2 text-xs" style={{ background: 'rgba(255, 255, 255, 0.03)' }}>
                  <span className="min-w-0 truncate" style={{ color: 'var(--foreground)' }}>
                    Gleicht: {other.name} ({day(other.date)})
                  </span>
                  <span className="flex shrink-0 gap-2">
                    <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onOpen(other.rowId)}>
                      Anderen ansehen
                    </button>
                    <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onKeepBoth(entry.rowId, other.rowId)}>
                      Beide behalten
                    </button>
                  </span>
                </div>
              ))}

              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="ui-btn ui-btn-sm ui-btn-primary" disabled={busy} onClick={() => onOpen(entry.rowId)}>
                  Beleg öffnen
                </button>
                {entry.canConfirm && (
                  <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onConfirm(entry.rowId)}>
                    Geprüft, stimmt so
                  </button>
                )}
                <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" disabled={busy} onClick={() => onDelete(entry.rowId)}>
                  Löschen
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
