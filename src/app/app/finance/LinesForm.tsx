'use client';

import { useId, useState } from 'react';
import { formatCents } from '@/lib/tax/money';
import type { StatementItem } from '@/lib/tax/service';
import { parseEuro } from './amounts';

export interface LineDraft {
  id?: string;
  description: string;
  grossCents: number;
  netCents: number | null;
}

interface Props {
  /** Any item of the receipt (the receipt itself, or one of its lines). */
  item: StatementItem;
  /** The receipt's stored lines, when it is already split (also when they no longer add up). */
  existing: StatementItem['receiptLines'];
  busy: boolean;
  error: string | null;
  /** Null: the form cannot be left without fixing the split. */
  onCancel: (() => void) | null;
  onSubmit: (lines: LineDraft[]) => void;
  /** Undo the split altogether; null when there is nothing to undo. */
  onRemove: (() => void) | null;
}

interface Row {
  id?: string;
  description: string;
  gross: string;
  net: string;
}

/**
 * Split a receipt into its positions. Amounts are in the receipt's own
 * currency and must add up to its total; the form shows what is still to be
 * distributed while typing and can put it into the first line without an amount.
 */
export default function LinesForm({ item, existing, busy, error, onCancel, onSubmit, onRemove }: Props) {
  const id = useId();
  const total = item.receiptGrossCents ?? 0;
  const [rows, setRows] = useState<Row[]>(() =>
    existing.length > 0
      ? existing.map((l) => ({ id: l.id, description: l.description, gross: formatCents(l.grossCents), net: l.netCents !== null ? formatCents(l.netCents) : '' }))
      : [
          { description: '', gross: '', net: '' },
          { description: '', gross: '', net: '' },
        ],
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const distributed = rows.reduce((s, r) => s + (parseEuro(r.gross) ?? 0), 0);
  const rest = total - distributed;
  const emptyAmount = rows.findIndex((r) => !r.gross.trim());
  const set = (index: number, patch: Partial<Row>) => setRows((list) => list.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const lines: LineDraft[] = [];
    for (const row of rows) {
      if (!row.description.trim() && !row.gross.trim()) continue;
      if (!row.description.trim()) return setLocalError('Bitte jede Position benennen.');
      const grossCents = parseEuro(row.gross);
      if (grossCents === null || grossCents <= 0) return setLocalError('Bitte für jede Position einen Betrag größer als null eingeben.');
      const netCents = row.net.trim() === '' ? null : parseEuro(row.net);
      if (row.net.trim() !== '' && (netCents === null || netCents <= 0 || netCents > grossCents)) {
        return setLocalError('Der Nettobetrag einer Position muss größer als null und höchstens so groß wie ihr Betrag sein.');
      }
      lines.push({ ...(row.id ? { id: row.id } : {}), description: row.description.trim(), grossCents, netCents });
    }
    if (lines.length < 2) return setLocalError('Eine Aufteilung braucht mindestens zwei Positionen.');
    if (lines.reduce((s, l) => s + l.grossCents, 0) !== total) return setLocalError('Die Positionen ergeben zusammen nicht den Belegbetrag.');
    setLocalError(null);
    onSubmit(lines);
  }

  const shown = localError ?? error;
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <p className="text-sm" style={{ color: 'var(--foreground)' }}>
        Belegbetrag {formatCents(total)} {item.currency}
        <span className="ml-2 text-xs" style={{ color: rest === 0 ? 'var(--muted)' : 'var(--accent)' }} role="status">
          {rest === 0 ? 'vollständig verteilt' : rest > 0 ? `noch zu verteilen: ${formatCents(rest)}` : `zu viel verteilt: ${formatCents(-rest)}`}
        </span>
        {rest > 0 && emptyAmount >= 0 && distributed > 0 && (
          <button type="button" className="ml-2 text-xs underline underline-offset-2" style={{ color: 'var(--accent)' }} onClick={() => set(emptyAmount, { gross: formatCents(rest) })}>
            Rest in Position {emptyAmount + 1} übernehmen
          </button>
        )}
      </p>
      <ul className="space-y-2">
        {rows.map((row, index) => (
          <li key={index} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_8rem_auto]">
            <div>
              <label className="ui-label" htmlFor={`${id}-d-${index}`}>Position {index + 1}</label>
              <input id={`${id}-d-${index}`} className="ui-input" value={row.description} onChange={(e) => set(index, { description: e.target.value })} maxLength={200} />
            </div>
            <div>
              <label className="ui-label" htmlFor={`${id}-g-${index}`}>Betrag</label>
              <input
                id={`${id}-g-${index}`}
                className="ui-input tabular-nums"
                inputMode="decimal"
                value={row.gross}
                onChange={(e) => set(index, { gross: e.target.value })}
              />
            </div>
            <div>
              <label className="ui-label" htmlFor={`${id}-n-${index}`}>davon netto</label>
              <input id={`${id}-n-${index}`} className="ui-input tabular-nums" inputMode="decimal" value={row.net} onChange={(e) => set(index, { net: e.target.value })} placeholder="optional" />
            </div>
            <button type="button" className="ui-btn ui-btn-sm self-end" disabled={rows.length <= 2} onClick={() => setRows((list) => list.filter((_, i) => i !== index))}>
              Entfernen
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="ui-btn ui-btn-sm" onClick={() => setRows((list) => [...list, { description: '', gross: '', net: '' }])}>
        Position hinzufügen
      </button>
      {shown && <p className="ui-note ui-note-danger" role="alert">{shown}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>{busy ? 'Speichert …' : 'Positionen speichern'}</button>
        {onCancel && <button type="button" className="ui-btn" onClick={onCancel}>Abbrechen</button>}
        {onRemove && (
          <button
            type="button"
            className="ui-btn ui-btn-danger"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('Die Aufteilung aufheben? Der Beleg ist dann wieder eine Position; Entscheidungen zu einzelnen Positionen gehen verloren.')) return;
              onRemove();
            }}
          >
            Aufteilung aufheben
          </button>
        )}
      </div>
    </form>
  );
}
