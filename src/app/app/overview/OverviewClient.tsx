'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import ScrollBox from '@/components/ui/ScrollBox';
import { formatDay } from '@/lib/meals/messages';
import { usePhone } from '@/lib/use-phone';
import { rankVendors, vendorChips } from '@/lib/overview/vendor-chips';
import { aggregateOverview, type OverviewData } from '@/lib/overview/aggregate';
import {
  applySelection,
  type LedgerInvoice,
  type SelectionDef,
  type TimePreset,
} from '@/lib/overview/selection';
import AttributionPanel from './AttributionPanel';
import NotesPanel from './NotesPanel';

const PALETTE = ['#4f8ef7', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6', '#eab308', '#ec4899', '#64748b', '#f97316'];

const PRESETS: { key: TimePreset; label: string }[] = [
  { key: '1w', label: 'Woche' },
  { key: '1m', label: 'Monat' },
  { key: '3m', label: '3 Monate' },
  { key: '6m', label: '6 Monate' },
  { key: 'ytd', label: 'Dieses Jahr' },
  { key: '1y', label: '12 Monate' },
  { key: 'all', label: 'Alle' },
];

/** How many vendor chips show before the list folds: fewer on a phone, where each chip takes a row's width. */
export const VENDOR_CHIPS_PHONE = 8;
export const VENDOR_CHIPS_WIDE = 16;

const money = (currency: string, n: number) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
const eur = (n: number) => money('EUR', n);
const plain = (n: number) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

/** A date of the ledger as a German day. The ledger may hold a full timestamp ("2021-01-14T00:00:00.000Z"). */
export function overviewDay(value: string | null): string {
  return formatDay(value ? value.slice(0, 10) : null);
}

const receiptCount = (n: number) => (n === 1 ? '1 Beleg' : `${n} Belege`);

const inputStyle = { background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)' } as const;

interface SavedSelection {
  id: string;
  name: string;
  definition: SelectionDef;
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl p-5 mb-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>{title}</h2>
        {subtitle && <span className="text-xs" style={{ color: 'var(--dt-text-secondary)' }}>{subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg p-4" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
      <div className="text-[11px] uppercase tracking-wide mb-1" style={{ color: 'var(--dt-text-secondary)' }}>{label}</div>
      <div className="text-xl font-semibold" style={{ color: 'var(--foreground)' }}>{value}</div>
      {sub && <div className="text-[11px] mt-1" style={{ color: 'var(--dt-text-secondary)' }}>{sub}</div>}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="px-2.5 py-1 text-xs rounded-full transition-colors"
      style={{
        background: active ? 'var(--accent-muted)' : 'var(--background)',
        color: active ? 'var(--accent)' : 'var(--dt-text-secondary)',
        border: `1px solid ${active ? 'rgba(226, 163, 72, 0.4)' : 'var(--border)'}`,
      }}
    >
      {children}
    </button>
  );
}

function HBars({ items, format }: { items: { label: string; value: number; color: string }[]; format: (n: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="flex flex-col gap-2">
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-3">
          <div className="w-40 shrink-0 text-xs truncate" style={{ color: 'var(--foreground)' }} title={it.label}>{it.label}</div>
          <div className="flex-1 h-5 rounded" style={{ background: 'var(--background)' }}>
            <div className="h-5 rounded" style={{ width: `${(it.value / max) * 100}%`, background: it.color, minWidth: it.value > 0 ? 2 : 0 }} />
          </div>
          <div className="w-24 shrink-0 text-right text-xs tabular-nums" style={{ color: 'var(--dt-text-secondary)' }}>{format(it.value)}</div>
        </div>
      ))}
    </div>
  );
}

/** The narrowest a month's column gets in the monthly chart (20px bar plus the 8px gap): below that the chart scrolls. */
export const MONTH_COLUMN_PX = 28;

function StackedMonthly({
  series,
  colorOf,
}: {
  series: OverviewData['monthlyByCurrency'][number];
  colorOf: (v: string) => string;
}) {
  const H = 160;
  const monthTotal = (m: (typeof series.months)[number]) => Object.values(m.byVendor).reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...series.months.map(monthTotal));
  // Two years of months do not fit a phone (or half a wide screen): every month keeps a readable column and the
  // chart scrolls sideways in its own box, never the page, opening on the newest months.
  const monthCount = series.months.length;
  return (
    <ScrollBox
      label={`${series.currency} je Monat`}
      pinEnd
      resetKey={monthCount}
      className="overflow-x-auto overscroll-x-contain pb-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]"
    >
      <div style={{ minWidth: monthCount * MONTH_COLUMN_PX }}>
        <div className="flex items-end gap-2" style={{ height: H }}>
          {series.months.map((m) => {
            const total = monthTotal(m);
            return (
              <div key={m.month} className="min-w-0 flex-1 flex flex-col items-center justify-end" title={`${m.month.slice(5, 7)}/${m.month.slice(0, 4)}: ${money(series.currency, total)}`}>
                <div className="w-full flex flex-col-reverse rounded-t overflow-hidden" style={{ height: `${(total / max) * H}px` }}>
                  {series.vendors
                    .filter((v) => m.byVendor[v])
                    .map((v) => (
                      <div key={v} style={{ height: `${(m.byVendor[v]! / Math.max(total, 1)) * 100}%`, background: colorOf(v) }} />
                    ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex gap-2 mt-1">
          {series.months.map((m, i) => (
            <div key={m.month} className="min-w-0 flex-1 text-center text-[10px] leading-tight tabular-nums" style={{ color: 'var(--dt-text-secondary)' }}>
              {m.month.slice(5)}
              {/* The year under the first month and under every January, so months of two years tell apart. */}
              {(i === 0 || m.month.endsWith('-01')) && <span className="block opacity-70">{m.month.slice(2, 4)}</span>}
            </div>
          ))}
        </div>
      </div>
    </ScrollBox>
  );
}

function Legend({ vendors, colorOf }: { vendors: string[]; colorOf: (v: string) => string }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 mb-3">
      {vendors.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 text-[11px]" style={{ color: 'var(--dt-text-secondary)' }}>
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: colorOf(v) }} />
          {v}
        </span>
      ))}
    </div>
  );
}

export default function OverviewClient({
  invoices,
  selections: initialSelections,
  attribution,
  notes,
}: {
  invoices: LedgerInvoice[];
  selections: SavedSelection[];
  attribution: { rules: { vendor: string; share: number }[]; defaultShare: number };
  notes: string;
}) {
  // ----- selection state -----
  const [preset, setPreset] = useState<TimePreset>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [vendorsOff, setVendorsOff] = useState<Set<string>>(new Set());
  const [currenciesOff, setCurrenciesOff] = useState<Set<string>>(new Set());
  const [pickMode, setPickMode] = useState<'exclude' | 'include'>('exclude');
  const [checked, setChecked] = useState<Set<string>>(() => new Set(invoices.map((i) => i.id)));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [vendorsExpanded, setVendorsExpanded] = useState(false);
  const [vendorQuery, setVendorQuery] = useState('');
  const isPhone = usePhone();

  // ----- saved selections -----
  const [saved, setSaved] = useState<SavedSelection[]>(initialSelections);
  const [activeId, setActiveId] = useState<string>('');
  const [saveName, setSaveName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Stable facts about the full ledger (colors, chips) regardless of filtering.
  const full = useMemo(() => aggregateOverview(invoices), [invoices]);
  const allVendors = full.vendors;
  const allCurrencies = useMemo(() => [...new Set(invoices.map((i) => i.currency))].sort(), [invoices]);
  const colorIndex = useMemo(() => new Map(allVendors.map((v, i) => [v, i])), [allVendors]);
  const colorOf = (v: string) => PALETTE[(colorIndex.get(v) ?? 0) % PALETTE.length]!;
  // The vendor chips, largest amount first, folded to the top ones (see `lib/overview/vendor-chips.ts`).
  const rankedVendors = useMemo(
    () => rankVendors(full.byVendorEur.map((v) => ({ vendor: v.vendor, amount: v.rawEur })), allVendors),
    [full.byVendorEur, allVendors],
  );
  const chips = vendorChips({
    ranked: rankedVendors,
    off: vendorsOff,
    limit: isPhone === false ? VENDOR_CHIPS_WIDE : VENDOR_CHIPS_PHONE,
    expanded: vendorsExpanded,
    query: vendorQuery,
  });

  // Current definition from the controls.
  const def = useMemo<SelectionDef>(() => {
    const d: SelectionDef = { preset };
    if (preset === 'custom') {
      if (from) d.from = from;
      if (to) d.to = to;
    }
    if (vendorsOff.size) d.vendors = allVendors.filter((v) => !vendorsOff.has(v));
    if (currenciesOff.size) d.currencies = allCurrencies.filter((c) => !currenciesOff.has(c));
    if (pickMode === 'include') {
      if (checked.size < invoices.length) d.includeIds = [...checked];
    } else {
      const excluded = invoices.filter((i) => !checked.has(i.id)).map((i) => i.id);
      if (excluded.length) d.excludeIds = excluded;
    }
    return d;
  }, [preset, from, to, vendorsOff, currenciesOff, pickMode, checked, invoices, allVendors, allCurrencies]);

  const filtered = useMemo(() => applySelection(invoices, def), [invoices, def]);
  const data = useMemo(() => aggregateOverview(filtered), [filtered]);
  const { totals, byVendorEur, byVendorNative, monthlyByCurrency } = data;

  const resetAll = () => {
    setPreset('all');
    setFrom('');
    setTo('');
    setVendorsOff(new Set());
    setCurrenciesOff(new Set());
    setPickMode('exclude');
    setChecked(new Set(invoices.map((i) => i.id)));
    setActiveId('');
    setSaveName('');
    setMsg(null);
  };

  const loadSelection = (sel: SavedSelection) => {
    const d = sel.definition;
    setPreset(d.preset ?? 'all');
    setFrom(d.from ?? '');
    setTo(d.to ?? '');
    setVendorsOff(new Set(d.vendors?.length ? allVendors.filter((v) => !d.vendors!.includes(v)) : []));
    setCurrenciesOff(new Set(d.currencies?.length ? allCurrencies.filter((c) => !d.currencies!.includes(c)) : []));
    if (d.includeIds?.length) {
      setPickMode('include');
      setChecked(new Set(d.includeIds));
    } else {
      setPickMode('exclude');
      const ex = new Set(d.excludeIds ?? []);
      setChecked(new Set(invoices.filter((i) => !ex.has(i.id)).map((i) => i.id)));
    }
    setActiveId(sel.id);
    setSaveName(sel.name);
    setMsg(null);
  };

  const saveSelection = async () => {
    const name = saveName.trim();
    if (!name) return;
    setBusy(true);
    setMsg(null);
    try {
      const active = saved.find((s) => s.id === activeId);
      const res = await fetch('/api/overview/selections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: active && active.name === name ? active.id : undefined, name, definition: def }),
      });
      const dataRes = await res.json();
      if (!res.ok) {
        setMsg(
          dataRes.error === 'name_taken'
            ? 'Der Name ist schon vergeben.'
            : dataRes.error === 'forbidden'
              ? 'Dafür fehlt die Berechtigung.'
              : 'Speichern fehlgeschlagen. Bitte noch einmal versuchen.',
        );
        return;
      }
      setSaved(dataRes.selections);
      const mine = (dataRes.selections as SavedSelection[]).find((s) => s.name === name);
      if (mine) setActiveId(mine.id);
      setMsg('Gespeichert.');
    } catch {
      setMsg('Speichern fehlgeschlagen. Bitte noch einmal versuchen.');
    } finally {
      setBusy(false);
    }
  };

  const deleteSelection = async () => {
    if (!activeId) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/overview/selections', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: activeId }),
      });
      const dataRes = await res.json();
      if (res.ok) {
        setSaved(dataRes.selections);
        setActiveId('');
        setSaveName('');
        setMsg('Gelöscht.');
      } else {
        setMsg('Löschen fehlgeschlagen. Bitte noch einmal versuchen.');
      }
    } catch {
      setMsg('Löschen fehlgeschlagen. Bitte noch einmal versuchen.');
    } finally {
      setBusy(false);
    }
  };

  const toggleIn = (set: Set<string>, key: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setter(next);
  };

  const eurCur = totals.byCurrency.find((c) => c.currency === 'EUR');
  const usdCur = totals.byCurrency.find((c) => c.currency !== 'EUR');
  const sortedForPicker = useMemo(
    () => [...invoices].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')),
    [invoices],
  );

  return (
    <main className="ui-touch mx-auto max-w-5xl p-4 sm:p-6">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--foreground)' }}>Ausgabenübersicht</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--dt-text-secondary)' }}>
            {filtered.length} von {invoices.length === 1 ? '1 Beleg' : `${invoices.length} Belegen`} in der Auswahl
            {totals.firstDate ? ` · ${overviewDay(totals.firstDate)} bis ${overviewDay(totals.lastDate)}` : ''}
          </p>
        </div>
        <Link href="/app/dashboard" className="shrink-0 text-sm underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center" style={{ color: 'var(--accent)' }}>← Belege</Link>
      </div>

      {/* Controls: time frame, saved selections, filters, picker */}
      <div className="rounded-xl p-4 mb-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {PRESETS.map((p) => (
            <Chip key={p.key} active={preset === p.key} onClick={() => setPreset(p.key)}>{p.label}</Chip>
          ))}
          <Chip active={preset === 'custom'} onClick={() => setPreset('custom')}>Zeitraum</Chip>
          {preset === 'custom' && (
            <span className="inline-flex items-center gap-1">
              <input type="date" aria-label="Von" value={from} onChange={(e) => setFrom(e.target.value)} className="px-2 py-1 text-xs rounded-md" style={inputStyle} />
              <span className="text-xs" style={{ color: 'var(--dt-text-secondary)' }}>bis</span>
              <input type="date" aria-label="Bis" value={to} onChange={(e) => setTo(e.target.value)} className="px-2 py-1 text-xs rounded-md" style={inputStyle} />
            </span>
          )}
          <span className="flex-1" />
          <select
            value={activeId}
            onChange={(e) => {
              const sel = saved.find((s) => s.id === e.target.value);
              if (sel) loadSelection(sel);
              else resetAll();
            }}
            className="px-2 py-1 text-xs rounded-md"
            style={inputStyle}
            aria-label="Gespeicherte Auswahl"
          >
            <option value="">Alle Belege (Standard)</option>
            {saved.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="Name der Auswahl"
            aria-label="Name der Auswahl"
            className="px-2 py-1 text-xs rounded-md w-36 max-sm:min-w-0 max-sm:flex-1"
            style={inputStyle}
          />
          <button
            onClick={saveSelection}
            aria-label="Auswahl speichern"
            disabled={busy || !saveName.trim()}
            className="px-2.5 py-1 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Speichern
          </button>
          {activeId && (
            <button onClick={deleteSelection} disabled={busy} aria-label="Auswahl löschen" className="px-2 py-1 text-xs rounded-md" style={{ color: '#f87171', border: '1px solid rgba(239,68,68,0.3)' }}>
              Löschen
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 mb-2" role="group" aria-label="Händler">
          <span className="text-[11px] mr-1" style={{ color: 'var(--dt-text-secondary)' }}>Händler:</span>
          {vendorsExpanded && chips.foldable && (
            <input
              type="search"
              value={vendorQuery}
              onChange={(e) => setVendorQuery(e.target.value)}
              placeholder="Händler suchen"
              aria-label="Händler suchen"
              className="w-full px-2 py-1 text-xs rounded-md sm:w-48"
              style={inputStyle}
            />
          )}
          {chips.shown.map((v) => (
            <Chip key={v} active={!vendorsOff.has(v)} onClick={() => toggleIn(vendorsOff, v, setVendorsOff)}>{v}</Chip>
          ))}
          {vendorsExpanded && chips.foldable && vendorQuery.trim() && chips.shown.length === 0 && (
            <span className="text-xs" style={{ color: 'var(--dt-text-secondary)' }}>Kein Händler passt zur Suche.</span>
          )}
          {chips.foldable && (
            <button
              type="button"
              onClick={() => {
                setVendorsExpanded((v) => !v);
                setVendorQuery('');
              }}
              aria-expanded={vendorsExpanded}
              className="text-xs underline"
              style={{ color: 'var(--accent)' }}
            >
              {vendorsExpanded ? 'Weniger anzeigen' : `Alle Händler anzeigen (${rankedVendors.length})`}
            </button>
          )}
          {vendorsOff.size > 0 && (
            <button type="button" onClick={() => setVendorsOff(new Set())} className="text-xs underline" style={{ color: 'var(--dt-text-secondary)' }}>
              {vendorsOff.size === 1 ? '1 Händler ausgeblendet, alle einbeziehen' : `${vendorsOff.size} Händler ausgeblendet, alle einbeziehen`}
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] mr-1" style={{ color: 'var(--dt-text-secondary)' }}>Währungen:</span>
          {allCurrencies.map((c) => (
            <Chip key={c} active={!currenciesOff.has(c)} onClick={() => toggleIn(currenciesOff, c, setCurrenciesOff)}>{c}</Chip>
          ))}
          <span className="flex-1" />
          <button onClick={() => setPickerOpen((v) => !v)} className="text-xs underline" style={{ color: 'var(--accent)' }}>
            {pickerOpen ? 'Belegauswahl ausblenden' : `Belege auswählen (${checked.size} von ${invoices.length})`}
          </button>
          <button type="button" onClick={resetAll} className="text-xs underline" style={{ color: 'var(--dt-text-secondary)' }}>Zurücksetzen</button>
        </div>

        {pickerOpen && (
          <div className="mt-3 rounded-lg p-3" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <label className="text-[11px] inline-flex items-center gap-1" style={{ color: 'var(--dt-text-secondary)' }}>
                <input type="radio" checked={pickMode === 'exclude'} onChange={() => setPickMode('exclude')} />
                Nicht angehakte weglassen (neue Belege kommen dazu)
              </label>
              <label className="text-[11px] inline-flex items-center gap-1" style={{ color: 'var(--dt-text-secondary)' }}>
                <input type="radio" checked={pickMode === 'include'} onChange={() => setPickMode('include')} />
                Nur angehakte (feste Auswahl)
              </label>
              <span className="flex-1" />
              <button onClick={() => setChecked(new Set(invoices.map((i) => i.id)))} className="text-[11px] underline" style={{ color: 'var(--accent)' }}>Alle</button>
              <button onClick={() => setChecked(new Set())} className="text-[11px] underline" style={{ color: 'var(--accent)' }}>Keine</button>
            </div>
            <div className="max-h-64 overflow-y-auto flex flex-col gap-0.5">
              {sortedForPicker.map((inv) => (
                <label key={inv.id} className="flex items-center gap-2 text-xs py-0.5 cursor-pointer" style={{ color: 'var(--foreground)' }}>
                  <input
                    type="checkbox"
                    checked={checked.has(inv.id)}
                    onChange={() => toggleIn(checked, inv.id, setChecked)}
                  />
                  <span className="w-20 shrink-0 tabular-nums" style={{ color: 'var(--dt-text-secondary)' }}>{overviewDay(inv.date)}</span>
                  <span className="w-36 shrink-0 truncate">{inv.vendor}</span>
                  <span className="flex-1 truncate" style={{ color: 'var(--dt-text-secondary)' }}>{inv.name ?? ''}</span>
                  <span className="shrink-0 tabular-nums">{money(inv.currency, inv.amountNative)}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        {msg && <p className="text-xs mt-2" style={{ color: 'var(--dt-text-secondary)' }}>{msg}</p>}
      </div>

      {/* Hero + tiles */}
      <div className="rounded-xl p-5 mb-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="text-[11px] uppercase tracking-wide mb-1" style={{ color: 'var(--dt-text-secondary)' }}>Geschäftlicher Anteil (Auswahl)</div>
        <div className="text-4xl font-semibold mb-1 tabular-nums" style={{ color: 'var(--foreground)' }}>{eur(totals.attributedEur)}</div>
        <div className="text-xs" style={{ color: 'var(--dt-text-secondary)' }}>
          {totals.blendedAttributionPct} % von {eur(totals.rawEur)} insgesamt berechnet (mit dem Anteil je Händler)
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Tile label="In EUR" value={eurCur ? eur(eurCur.amountNative) : 'keine'} sub={eurCur ? receiptCount(eurCur.invoiceCount) : undefined} />
        <Tile label={usdCur ? `In ${usdCur.currency}` : 'Andere Währung'} value={usdCur ? money(usdCur.currency, usdCur.amountNative) : 'keine'} sub={usdCur ? `${receiptCount(usdCur.invoiceCount)} · ${usdCur.vendorCount} Händler` : undefined} />
        <Tile label="Belege in der Auswahl" value={String(totals.invoiceCount)} sub={totals.firstDate ? `${overviewDay(totals.firstDate)} bis ${overviewDay(totals.lastDate)}` : undefined} />
        <Tile label="Insgesamt berechnet (100 %)" value={eur(totals.rawEur)} sub="vor dem geschäftlichen Anteil" />
      </div>

      {monthlyByCurrency.length > 0 && (
        <Section title="Ausgaben je Monat und Händler" subtitle="Jede Währung mit eigener Skala; geschäftlicher Anteil">
          <Legend vendors={data.vendors} colorOf={colorOf} />
          {/* One chart per row on a phone; side by side from the small breakpoint on. The columns are bounded
              (minmax 0), so a long chart scrolls in its own panel instead of widening the page. */}
          <div
            className="grid grid-cols-1 gap-6 sm:[grid-template-columns:var(--overview-cols)]"
            style={{ '--overview-cols': `repeat(${Math.min(monthlyByCurrency.length, 2)}, minmax(0,1fr))` } as React.CSSProperties}
          >
            {monthlyByCurrency.map((s) => (
              <div key={s.currency}>
                <div className="text-xs mb-2" style={{ color: 'var(--dt-text-secondary)' }}>{s.currency}</div>
                <StackedMonthly series={s} colorOf={colorOf} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {byVendorEur.length > 0 && (
        <Section title="Summe je Händler" subtitle="in Euro umgerechnet, geschäftlicher Anteil">
          <HBars items={byVendorEur.map((v) => ({ label: v.vendor, value: v.attributedEur, color: colorOf(v.vendor) }))} format={eur} />
        </Section>
      )}

      {byVendorNative.length > 0 && (
        <Section title="Summe je Händler in der Originalwährung" subtitle="vor der Umrechnung">
          <HBars
            items={byVendorNative.map((v) => ({ label: `${v.vendor} (${v.currency})`, value: v.amountNative, color: colorOf(v.vendor) }))}
            format={plain}
          />
        </Section>
      )}

      <Section title="Geschäftlicher Anteil je Händler">
        <AttributionPanel initialRules={attribution.rules} initialDefault={attribution.defaultShare} />
      </Section>
      <Section title="Notizen">
        <NotesPanel initial={notes} />
      </Section>

      {invoices.length === 0 && (
        <p className="text-sm text-center mt-8" style={{ color: 'var(--dt-text-secondary)' }}>
          Noch keine Belege. Aus Google Sheets importieren oder Belege hochladen, dann füllt sich diese Übersicht.
        </p>
      )}
      {invoices.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-center mt-8" style={{ color: 'var(--dt-text-secondary)' }}>
          Keine Belege in dieser Auswahl. Den Zeitraum erweitern oder die Filter zurücksetzen.
        </p>
      )}
    </main>
  );
}
