'use client';

import type { Column, Row } from '@marlinjai/data-table-core';
import BottomSheet from '@/components/ui/BottomSheet';
import { sumOf } from '@/lib/groups/view';

const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function day(value: unknown): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * What opens for a group in place of the receipt panel: the receipts it holds,
 * their sum in euros, and the two things a person does with a group. A group
 * has no file, no amount of its own and no meal details, so none are offered.
 */
export default function GroupPanel({
  group,
  receipts,
  columns,
  busy,
  onClose,
  onOpenReceipt,
  onTakeOut,
  onDissolve,
}: {
  group: Row;
  /** The receipts that lie in the group. */
  receipts: Row[];
  columns: Column[];
  busy: boolean;
  onClose: () => void;
  onOpenReceipt: (row: Row) => void;
  onTakeOut: (rowId: string) => void;
  onDissolve: () => void;
}) {
  const id = (name: string) => columns.find((c) => c.name === name)?.id ?? '';
  const nameId = id('Name');
  const dateId = id('Date');
  const euroId = id('EUR Equivalent');
  const title = text(group.cells[nameId]) || 'Gruppe ohne Namen';

  return (
    <BottomSheet open title={title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm" style={{ color: 'rgba(232, 230, 227, 0.8)' }}>
          {receipts.length === 0
            ? 'Die Gruppe ist leer. Belege in der Tabelle auswählen und über „In Gruppe legen“ hinzufügen.'
            : `${receipts.length === 1 ? '1 Beleg' : `${receipts.length} Belege`}, zusammen ${euro.format(sumOf(receipts, euroId))}. Die Gruppe selbst zählt nicht als Beleg.`}
        </p>

        {receipts.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {receipts.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 rounded-lg px-3 py-2"
                style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255, 255, 255, 0.02)' }}
              >
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenReceipt(row)} title="Beleg öffnen">
                  <span className="block truncate text-sm" style={{ color: 'var(--foreground)' }}>
                    {text(row.cells[nameId]) || 'Beleg ohne Namen'}
                  </span>
                  <span className="block text-xs tabular-nums" style={{ color: 'rgba(232, 230, 227, 0.62)' }}>
                    {[day(row.cells[dateId]), euro.format(sumOf([row], euroId))].filter(Boolean).join(' · ')}
                  </span>
                </button>
                <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost shrink-0" disabled={busy} onClick={() => onTakeOut(row.id)}>
                  Herausnehmen
                </button>
              </li>
            ))}
          </ul>
        )}

        <div>
          <button type="button" className="ui-btn ui-btn-danger" disabled={busy} onClick={onDissolve}>
            Gruppe auflösen
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
