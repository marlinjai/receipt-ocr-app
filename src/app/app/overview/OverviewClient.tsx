'use client';

import Link from 'next/link';
import type { OverviewData } from '@/lib/overview/aggregate';
import AttributionPanel from './AttributionPanel';
import NotesPanel from './NotesPanel';

const PALETTE = ['#4f8ef7', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6', '#eab308', '#ec4899', '#64748b', '#f97316'];

const money = (currency: string, n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
const eur = (n: number) => money('EUR', n);

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

// Horizontal bars: [{ label, value, color }], width ∝ value/max.
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

// Stacked vertical bars, one column per month, segments per vendor.
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
  data,
  attribution,
  notes,
}: {
  data: OverviewData;
  attribution: { rules: { vendor: string; share: number }[]; defaultShare: number };
  notes: string;
}) {
  const { totals, byVendorEur, byVendorNative, monthlyByCurrency } = data;
  const colorIndex = new Map(data.vendors.map((v, i) => [v, i]));
  const colorOf = (v: string) => PALETTE[(colorIndex.get(v) ?? 0) % PALETTE.length]!;

  const eurCur = totals.byCurrency.find((c) => c.currency === 'EUR');
  const usdCur = totals.byCurrency.find((c) => c.currency !== 'EUR'); // headline non-EUR

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--foreground)' }}>Spend overview</h1>
          {totals.firstDate && (
            <p className="text-xs mt-1" style={{ color: 'var(--dt-text-secondary)' }}>
              {totals.firstDate} → {totals.lastDate} · {totals.invoiceCount} invoices
            </p>
          )}
        </div>
        <Link href="/app/dashboard" className="text-sm underline" style={{ color: 'var(--accent)' }}>← Ledger</Link>
      </div>

      {/* Hero + tiles */}
      <div className="rounded-xl p-5 mb-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="text-[11px] uppercase tracking-wide mb-1" style={{ color: 'var(--dt-text-secondary)' }}>Total attributed spend</div>
        <div className="text-4xl font-semibold mb-1" style={{ color: 'var(--foreground)' }}>{eur(totals.attributedEur)}</div>
        <div className="text-xs" style={{ color: 'var(--dt-text-secondary)' }}>
          {totals.blendedAttributionPct}% of {eur(totals.rawEur)} raw billed (per-vendor attribution applied)
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Tile label="EUR-native" value={eurCur ? eur(eurCur.amountNative) : '—'} sub={eurCur ? `${eurCur.invoiceCount} invoices` : undefined} />
        <Tile label={usdCur ? `${usdCur.currency}-native` : 'Non-EUR'} value={usdCur ? money(usdCur.currency, usdCur.amountNative) : '—'} sub={usdCur ? `${usdCur.invoiceCount} invoices · ${usdCur.vendorCount} vendors` : undefined} />
        <Tile label="Invoices on file" value={String(totals.invoiceCount)} sub={totals.firstDate ? `${totals.firstDate} → ${totals.lastDate}` : undefined} />
        <Tile label="Raw billed (100%)" value={eur(totals.rawEur)} sub="before attribution" />
      </div>

      {/* Monthly by vendor, per currency (separate scales) */}
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

      {/* Total by vendor, EUR equiv */}
      {byVendorEur.length > 0 && (
        <Section title="Total by vendor" subtitle="EUR equivalent, attributed">
          <HBars items={byVendorEur.map((v) => ({ label: v.vendor, value: v.attributedEur, color: colorOf(v.vendor) }))} format={eur} />
        </Section>
      )}

      {/* Native currency */}
      {byVendorNative.length > 0 && (
        <Section title="Total by vendor, native currency" subtitle="before FX conversion">
          <HBars
            items={byVendorNative.map((v) => ({ label: `${v.vendor} (${v.currency})`, value: v.amountNative, color: colorOf(v.vendor) }))}
            format={(n) => n.toFixed(2)}
          />
        </Section>
      )}

      {/* Attribution + notes */}
      <Section title="Attribution">
        <AttributionPanel initialRules={attribution.rules} initialDefault={attribution.defaultShare} />
      </Section>
      <Section title="Notes">
        <NotesPanel initial={notes} />
      </Section>

      {totals.invoiceCount === 0 && (
        <p className="text-sm text-center mt-8" style={{ color: 'var(--dt-text-secondary)' }}>
          No invoices yet. Import from Sheets or upload receipts, then this overview fills in.
        </p>
      )}
    </main>
  );
}
