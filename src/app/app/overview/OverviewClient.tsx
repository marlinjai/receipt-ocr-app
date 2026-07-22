'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
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
  { key: '1w', label: '1W' },
  { key: '1m', label: '1M' },
  { key: '3m', label: '3M' },
  { key: '6m', label: '6M' },
  { key: 'ytd', label: 'YTD' },
  { key: '1y', label: '1Y' },
  { key: 'all', label: 'All' },
];

const money = (currency: string, n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
const eur = (n: number) => money('EUR', n);

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
      onClick={onClick}
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
  return (
    <div>
      <div className="flex items-end gap-2" style={{ height: H }}>
        {series.months.map((m) => {
          const total = monthTotal(m);
          return (
            <div key={m.month} className="flex-1 flex flex-col items-center justify-end" title={`${m.month}: ${money(series.currency, total)}`}>
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
        {series.months.map((m) => (
          <div key={m.month} className="flex-1 text-center text-[10px]" style={{ color: 'var(--dt-text-secondary)' }}>
            {m.month.slice(5)}
          </div>
        ))}
      </div>
    </div>
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
        setMsg(dataRes.error === 'name_taken' ? 'Name already taken' : 'Save failed');
        return;
      }
      setSaved(dataRes.selections);
      const mine = (dataRes.selections as SavedSelection[]).find((s) => s.name === name);
      if (mine) setActiveId(mine.id);
      setMsg('Saved.');
    } catch {
      setMsg('Save failed');
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
        setMsg('Deleted.');
      } else {
        setMsg('Delete failed');
      }
    } catch {
      setMsg('Delete failed');
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
    <main className="mx-auto max-w-5xl p-6">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--foreground)' }}>Spend overview</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--dt-text-secondary)' }}>
            {filtered.length} of {invoices.length} invoices in view
            {totals.firstDate ? ` · ${totals.firstDate} → ${totals.lastDate}` : ''}
          </p>
        </div>
        <Link href="/app/dashboard" className="text-sm underline" style={{ color: 'var(--accent)' }}>← Ledger</Link>
      </div>

      {/* Controls: time frame, saved selections, filters, picker */}
      <div className="rounded-xl p-4 mb-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {PRESETS.map((p) => (
            <Chip key={p.key} active={preset === p.key} onClick={() => setPreset(p.key)}>{p.label}</Chip>
          ))}
          <Chip active={preset === 'custom'} onClick={() => setPreset('custom')}>Custom</Chip>
          {preset === 'custom' && (
            <span className="inline-flex items-center gap-1">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-2 py-1 text-xs rounded-md" style={inputStyle} />
              <span className="text-xs" style={{ color: 'var(--dt-text-secondary)' }}>→</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-2 py-1 text-xs rounded-md" style={inputStyle} />
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
          >
            <option value="">All invoices (default)</option>
            {saved.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="Selection name"
            className="px-2 py-1 text-xs rounded-md w-36"
            style={inputStyle}
          />
          <button
            onClick={saveSelection}
            disabled={busy || !saveName.trim()}
            className="px-2.5 py-1 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Save
          </button>
          {activeId && (
            <button onClick={deleteSelection} disabled={busy} className="px-2 py-1 text-xs rounded-md" style={{ color: '#f87171', border: '1px solid rgba(239,68,68,0.3)' }}>
              Delete
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          <span className="text-[11px] mr-1" style={{ color: 'var(--dt-text-secondary)' }}>Vendors:</span>
          {allVendors.map((v) => (
            <Chip key={v} active={!vendorsOff.has(v)} onClick={() => toggleIn(vendorsOff, v, setVendorsOff)}>{v}</Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] mr-1" style={{ color: 'var(--dt-text-secondary)' }}>Currencies:</span>
          {allCurrencies.map((c) => (
            <Chip key={c} active={!currenciesOff.has(c)} onClick={() => toggleIn(currenciesOff, c, setCurrenciesOff)}>{c}</Chip>
          ))}
          <span className="flex-1" />
          <button onClick={() => setPickerOpen((v) => !v)} className="text-xs underline" style={{ color: 'var(--accent)' }}>
            {pickerOpen ? 'Hide invoice picker' : `Pick invoices (${checked.size}/${invoices.length})`}
          </button>
          <button onClick={resetAll} className="text-xs underline" style={{ color: 'var(--dt-text-secondary)' }}>Reset</button>
        </div>

        {pickerOpen && (
          <div className="mt-3 rounded-lg p-3" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <label className="text-[11px] inline-flex items-center gap-1" style={{ color: 'var(--dt-text-secondary)' }}>
                <input type="radio" checked={pickMode === 'exclude'} onChange={() => setPickMode('exclude')} />
                Exclude unchecked (live: new imports stay in)
              </label>
              <label className="text-[11px] inline-flex items-center gap-1" style={{ color: 'var(--dt-text-secondary)' }}>
                <input type="radio" checked={pickMode === 'include'} onChange={() => setPickMode('include')} />
                Only checked (frozen set)
              </label>
              <span className="flex-1" />
              <button onClick={() => setChecked(new Set(invoices.map((i) => i.id)))} className="text-[11px] underline" style={{ color: 'var(--accent)' }}>All</button>
              <button onClick={() => setChecked(new Set())} className="text-[11px] underline" style={{ color: 'var(--accent)' }}>None</button>
            </div>
            <div className="max-h-64 overflow-y-auto flex flex-col gap-0.5">
              {sortedForPicker.map((inv) => (
                <label key={inv.id} className="flex items-center gap-2 text-xs py-0.5 cursor-pointer" style={{ color: 'var(--foreground)' }}>
                  <input
                    type="checkbox"
                    checked={checked.has(inv.id)}
                    onChange={() => toggleIn(checked, inv.id, setChecked)}
                  />
                  <span className="w-20 shrink-0 tabular-nums" style={{ color: 'var(--dt-text-secondary)' }}>{inv.date ?? '—'}</span>
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
        <div className="text-[11px] uppercase tracking-wide mb-1" style={{ color: 'var(--dt-text-secondary)' }}>Total attributed spend (selection)</div>
        <div className="text-4xl font-semibold mb-1" style={{ color: 'var(--foreground)' }}>{eur(totals.attributedEur)}</div>
        <div className="text-xs" style={{ color: 'var(--dt-text-secondary)' }}>
          {totals.blendedAttributionPct}% of {eur(totals.rawEur)} raw billed (per-vendor attribution applied)
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Tile label="EUR-native" value={eurCur ? eur(eurCur.amountNative) : '—'} sub={eurCur ? `${eurCur.invoiceCount} invoices` : undefined} />
        <Tile label={usdCur ? `${usdCur.currency}-native` : 'Non-EUR'} value={usdCur ? money(usdCur.currency, usdCur.amountNative) : '—'} sub={usdCur ? `${usdCur.invoiceCount} invoices · ${usdCur.vendorCount} vendors` : undefined} />
        <Tile label="Invoices in view" value={String(totals.invoiceCount)} sub={totals.firstDate ? `${totals.firstDate} → ${totals.lastDate}` : undefined} />
        <Tile label="Raw billed (100%)" value={eur(totals.rawEur)} sub="before attribution" />
      </div>

      {monthlyByCurrency.length > 0 && (
        <Section title="Monthly spend by vendor" subtitle="Currencies on separate scales; attributed share">
          <Legend vendors={data.vendors} colorOf={colorOf} />
          <div className="grid gap-6" style={{ gridTemplateColumns: `repeat(${Math.min(monthlyByCurrency.length, 2)}, minmax(0,1fr))` }}>
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
        <Section title="Total by vendor" subtitle="EUR equivalent, attributed">
          <HBars items={byVendorEur.map((v) => ({ label: v.vendor, value: v.attributedEur, color: colorOf(v.vendor) }))} format={eur} />
        </Section>
      )}

      {byVendorNative.length > 0 && (
        <Section title="Total by vendor, native currency" subtitle="before FX conversion">
          <HBars
            items={byVendorNative.map((v) => ({ label: `${v.vendor} (${v.currency})`, value: v.amountNative, color: colorOf(v.vendor) }))}
            format={(n) => n.toFixed(2)}
          />
        </Section>
      )}

      <Section title="Attribution">
        <AttributionPanel initialRules={attribution.rules} initialDefault={attribution.defaultShare} />
      </Section>
      <Section title="Notes">
        <NotesPanel initial={notes} />
      </Section>

      {invoices.length === 0 && (
        <p className="text-sm text-center mt-8" style={{ color: 'var(--dt-text-secondary)' }}>
          No invoices yet. Import from Sheets or upload receipts, then this overview fills in.
        </p>
      )}
      {invoices.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-center mt-8" style={{ color: 'var(--dt-text-secondary)' }}>
          Nothing matches the current selection. Widen the time frame or reset the filters.
        </p>
      )}
    </main>
  );
}
