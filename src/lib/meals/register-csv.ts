import { escapeCSVField, formatDateDE, formatNumberDE } from '@/lib/export-csv';
import { formatGuest } from '@/lib/contacts/store';
import { MISSING_FIELD_LABELS } from './rules';
import type { MealRegister } from './register';
import type { MealRecord } from './types';

/**
 * The register as comma-separated values: semicolon delimiter, German number
 * and date format, like the existing ledger export. The last columns repeat the
 * names of the earlier spreadsheet automation (`hospitality.type`, `occasion`,
 * `guests`, `guest_count`, `tip`, `consumption_type`, `deductibility_hint`) so
 * old sheets and this export line up.
 */

export const REGISTER_CSV_HEADERS = [
  'Nr',
  'Status',
  'Datum',
  'Ort',
  'Teilnehmer',
  'Anzahl Teilnehmer',
  'Anlass',
  'Gastgeber',
  'Rechnungsbetrag brutto (EUR)',
  'Trinkgeld (EUR)',
  'Netto (EUR)',
  'Vorsteuer (EUR)',
  'Bemessungsgrundlage (EUR)',
  'Abziehbar 70 % (EUR)',
  'Nicht abziehbar 30 % (EUR)',
  'Umsatzsteuer geschätzt',
  'Fehlende Angaben',
  'Angaben erfasst am',
  'Beleg',
  'hospitality.type',
  'occasion',
  'guests',
  'guest_count',
  'tip',
  'consumption_type',
  'deductibility_hint',
] as const;

/**
 * Neutralize spreadsheet formulas: a cell starting with = + - @ (or a tab or
 * carriage return) would be executed by Excel and friends. Free text here
 * comes from typed input and from receipts, so it is prefixed with an
 * apostrophe instead.
 */
export function csvSafeText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function text(value: string): string {
  return escapeCSVField(csvSafeText(value));
}

function money(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : escapeCSVField(formatNumberDE(value));
}

function timestampDE(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function dateDE(isoDay: string | null): string {
  // Parse as a plain calendar day; never shift it through a time zone.
  if (!isoDay) return '';
  const [y, m, d] = isoDay.split('-');
  return y && m && d ? `${d}.${m}.${y}` : formatDateDE(isoDay);
}

function guestList(record: MealRecord): string {
  return record.guests.map((g) => csvSafeText(formatGuest(g.name, g.company))).join(', ');
}

function receiptRef(record: MealRecord): string {
  return record.files.map((f) => csvSafeText(f.originalName)).join(', ') || record.rowId;
}

export function registerCsv(register: MealRegister): string {
  const lines: string[] = [REGISTER_CSV_HEADERS.map((h) => escapeCSVField(h)).join(';')];

  const common = (record: MealRecord) => ({
    date: escapeCSVField(dateDE(record.date)),
    place: text(record.place),
    guests: text(guestList(record)),
    guestCount: String(record.guests.length),
    occasion: text(record.occasion),
    host: text(record.host),
    detailsAt: escapeCSVField(timestampDE(record.detailsAt)),
    receipt: text(receiptRef(record)),
    type: record.mealType ?? '',
    consumption: record.consumption ?? '',
  });

  for (const entry of register.entries) {
    const c = common(entry.record);
    const d = entry.deduction;
    lines.push(
      [
        String(entry.no),
        'vollständig',
        c.date,
        c.place,
        c.guests,
        c.guestCount,
        c.occasion,
        c.host,
        money(d?.gross),
        money(d?.tip),
        money(d?.net),
        money(d?.inputVat),
        money(d?.base),
        money(d?.deductible),
        money(d?.nonDeductible),
        d ? (d.vatEstimated ? 'Ja' : d.basis === 'net' ? 'Nein' : '') : '',
        '',
        c.detailsAt,
        c.receipt,
        c.type,
        c.occasion,
        c.guests,
        c.guestCount,
        money(d?.tip),
        c.consumption,
        d ? text(`70 % abziehbar (${d.basis === 'gross' ? 'brutto, § 19 UStG' : 'netto'})`) : '',
      ].join(';'),
    );
  }

  if (register.totals) {
    const t = register.totals;
    lines.push(
      [
        '',
        'Summe',
        '',
        '',
        '',
        '',
        '',
        '',
        money(t.gross),
        money(t.tip),
        money(t.net),
        money(t.inputVat),
        money(t.base),
        money(t.deductible),
        money(t.nonDeductible),
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        money(t.tip),
        '',
        '',
      ].join(';'),
    );
  }

  // Incomplete entries: listed, never in the totals, no amounts claimed.
  for (const entry of register.incomplete) {
    const c = common(entry.record);
    lines.push(
      [
        '',
        'unvollständig',
        c.date,
        c.place,
        c.guests,
        c.guestCount,
        c.occasion,
        c.host,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        text(entry.missing.map((m) => MISSING_FIELD_LABELS[m]).join(', ')),
        c.detailsAt,
        c.receipt,
        c.type,
        c.occasion,
        c.guests,
        c.guestCount,
        '',
        c.consumption,
        text('nicht abziehbar, Angaben fehlen'),
      ].join(';'),
    );
  }

  return lines.join('\r\n');
}

/** UTF-8 byte order mark so spreadsheet programs read the umlauts correctly. */
export const CSV_BOM = '﻿';
