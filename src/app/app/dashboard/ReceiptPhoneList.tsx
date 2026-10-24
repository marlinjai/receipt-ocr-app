'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import type { Column, Row, SelectOption } from '@marlinjai/data-table-core';
import { isGroupRow } from '@/lib/receipts-kind';
import { groupCellValue, receiptsInGroup } from '@/lib/groups/view';

/**
 * The receipts table as a phone shows it: one card per receipt with what a
 * person looks for on the go (vendor, date, amount, category, status), and a
 * tap opens the same detail panel the table opens. It draws exactly the rows
 * it is given, so the year chips, the search and the filters above it narrow
 * it the same way they narrow the table. A group is one card with its sum;
 * its receipts are inside it (the group panel lists them), not repeated here.
 *
 * Plan: docs/plans/2026-10-24-phone-layout.md.
 */

const DAY = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A date cell as the person reads it, or empty when the cell holds no date. */
export function phoneDay(value: unknown): string {
  if (!value) return '';
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!match) return '';
  return DAY.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
}

/** An amount in its currency; without a known currency code the bare number, never a guessed euro sign. */
export function phoneAmount(value: unknown, currency: string): string {
  if (value === null || value === undefined || String(value).trim() === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (/^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(n);
    } catch {
      // An unknown code falls through to the bare number.
    }
  }
  return new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

/** The ISO date of a row, for sorting; empty when it has none. */
function sortKey(row: Row, dateId: string): string {
  const raw = row.cells[dateId];
  if (!raw) return '';
  const value = raw instanceof Date ? raw.toISOString() : String(raw);
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
}

export interface ReceiptPhoneListProps {
  /** The rows the page shows (years, search and filters already applied), groups and receipts alike. */
  rows: Row[];
  /** Every loaded row, so a group card can say when a search or filter shows only some of its receipts. */
  loadedRows: Row[];
  columns: Column[];
  selectOptions: Map<string, SelectOption[]>;
  /** True while rows are still on their way (the first page, or a reload after a change of years). */
  loading: boolean;
  /** True when loading failed: the page says so in its banner, and the list must not call itself empty. */
  failed: boolean;
  /** True when a search, a filter or a year choice narrows the list, so an empty list says why. */
  narrowed: boolean;
  onOpenReceipt: (row: Row) => void;
  onOpenGroup: (row: Row) => void;
}

export default function ReceiptPhoneList({ rows, loadedRows, columns, selectOptions, loading, failed, narrowed, onOpenReceipt, onOpenGroup }: ReceiptPhoneListProps) {
  const id = (name: string) => columns.find((c) => c.name === name)?.id ?? '';
  const nameId = id('Name');
  const vendorId = id('Vendor');
  const dateId = id('Date');
  const grossId = id('Gross');
  const euroId = id('EUR Equivalent');
  const categoryId = id('Category');
  const statusId = id('Status');
  const currencyId = id('Currency');

  const optionName = (columnId: string, value: unknown): string => {
    if (!columnId || typeof value !== 'string' || !value) return '';
    return selectOptions.get(columnId)?.find((o) => o.id === value)?.name ?? '';
  };

  // Top level: every group, and every receipt that does not lie in a group shown here. Newest first, undated last.
  const items = useMemo(() => {
    const shownGroups = new Set(rows.filter((r) => isGroupRow(r, columns)).map((r) => r.id));
    const top = rows.filter((r) => !(r.parentRowId && shownGroups.has(r.parentRowId)));
    return [...top].sort((a, b) => {
      const ka = sortKey(a, dateId);
      const kb = sortKey(b, dateId);
      if (ka === kb) return 0;
      if (!ka) return 1;
      if (!kb) return -1;
      return ka < kb ? 1 : -1;
    });
  }, [rows, columns, dateId]);

  if (items.length === 0) {
    // The banner above says the receipts could not be loaded; an empty list here would contradict it.
    if (failed) return null;
    if (loading) {
      return (
        <p role="status" className="px-1 py-10 text-center text-sm" style={{ color: 'var(--muted)' }}>
          Belege werden geladen …
        </p>
      );
    }
    return (
      <div className="glass-panel rounded-xl px-5 py-8 text-center">
        <p className="text-base font-medium" style={{ color: 'var(--foreground)' }}>
          {narrowed ? 'Keine Belege für diese Auswahl.' : 'Noch keine Belege.'}
        </p>
        <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
          {narrowed ? 'Suche, Filter oder Jahre oben ändern, um mehr zu sehen.' : 'Ein Foto oder eine Datei hochladen, der Beleg wird gelesen und hier eingetragen.'}
        </p>
        {!narrowed && (
          <Link href="/app" className="ui-btn ui-btn-primary mt-4">
            Beleg hochladen
          </Link>
        )}
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2" aria-label="Belege">
      {items.map((row) => {
        if (isGroupRow(row, columns)) {
          // The sum and count are of the receipts shown, like the wide table; the group panel lists all of them.
          // "x von y" covers what a search or filter hides among the loaded rows. Receipts of years that are not
          // loaded are not counted: the server sends only the chosen years, and the wide table counts the same.
          const children = receiptsInGroup(row.id, rows, columns);
          const all = receiptsInGroup(row.id, loadedRows, columns).length;
          const euroColumn = columns.find((c) => c.id === euroId);
          const sum = euroColumn ? groupCellValue(row, children, euroColumn, columns) : null;
          const name = text(row.cells[nameId]) || 'Gruppe ohne Namen';
          return (
            <li key={row.id} className="ui-phone-card">
              <button type="button" className="ui-phone-card-button" onClick={() => onOpenGroup(row)} aria-label={`Gruppe ${name} öffnen`}>
                <span className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
                    {name}
                  </span>
                  <span className="shrink-0 text-right text-sm font-semibold tabular-nums" style={{ color: 'var(--foreground)' }}>
                    {phoneAmount(sum, 'EUR') || <span className="font-normal" style={{ color: 'var(--muted)' }}>kein Betrag</span>}
                  </span>
                </span>
                <span className="mt-1 block text-xs" style={{ color: 'var(--muted)' }}>
                  Gruppe · {all > children.length ? `${children.length} von ${all} Belegen` : children.length === 1 ? '1 Beleg' : `${children.length} Belege`}
                </span>
              </button>
            </li>
          );
        }
        const vendor = text(row.cells[vendorId]) || text(row.cells[nameId]) || 'Beleg ohne Namen';
        const currency = optionName(currencyId, row.cells[currencyId]);
        const amount = phoneAmount(row.cells[grossId], currency);
        const category = optionName(categoryId, row.cells[categoryId]);
        const status = optionName(statusId, row.cells[statusId]);
        const date = phoneDay(row.cells[dateId]);
        return (
          <li key={row.id} className="ui-phone-card">
            <button type="button" className="ui-phone-card-button" onClick={() => onOpenReceipt(row)} aria-label={`Beleg ${vendor}${date ? ` vom ${date}` : ''} öffnen`}>
              <span className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="truncate text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                  {vendor}
                </span>
                <span className="shrink-0 text-right text-sm font-semibold tabular-nums" style={{ color: 'var(--foreground)' }}>
                  {amount || <span className="font-normal" style={{ color: 'var(--muted)' }}>kein Betrag</span>}
                </span>
              </span>
              <span className="mt-1 flex min-w-0 items-center justify-between gap-3 text-xs" style={{ color: 'var(--muted)' }}>
                <span className="truncate">{[date || 'ohne Datum', category].filter(Boolean).join(' · ')}</span>
                {status && <span className="ui-phone-chip shrink-0">{status}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
