import { describe, it, expect } from 'vitest';
import { aggregateOverview, type InvoiceRecord } from './aggregate';

// Mirrors the artifact's shape: Anthropic at 30% attribution (EUR), a USD vendor,
// and a 100% EUR vendor across two months.
const INVOICES: InvoiceRecord[] = [
  { vendor: 'Anthropic (Claude)', currency: 'EUR', amountNative: 164.25, fxRate: 1, businessShare: 30, date: '2026-01-11' },
  { vendor: 'Anthropic (Claude)', currency: 'EUR', amountNative: 180.0, fxRate: 1, businessShare: 30, date: '2026-02-11' },
  { vendor: 'ElevenLabs', currency: 'USD', amountNative: 13.09, fxRate: 0.8498, businessShare: 100, date: '2026-02-20' },
  { vendor: 'Google Workspace', currency: 'EUR', amountNative: 20.4, fxRate: 1, businessShare: 100, date: '2026-01-01' },
];

describe('aggregateOverview', () => {
  const d = aggregateOverview(INVOICES);

  it('computes attributed vs raw EUR totals', () => {
    // attributed: 164.25*.3 + 180*.3 + 13.09*0.8498 + 20.4 = 49.275 + 54 + 11.123 + 20.4 ≈ 134.80
    expect(d.totals.attributedEur).toBeCloseTo(134.8, 1);
    // raw: 164.25 + 180 + 11.123 + 20.4 ≈ 375.77
    expect(d.totals.rawEur).toBeCloseTo(375.77, 1);
    expect(d.totals.invoiceCount).toBe(4);
    expect(d.totals.firstDate).toBe('2026-01-01');
    expect(d.totals.lastDate).toBe('2026-02-20');
    expect(d.totals.blendedAttributionPct).toBeGreaterThan(0);
  });

  it('splits totals by currency', () => {
    const eur = d.totals.byCurrency.find((c) => c.currency === 'EUR')!;
    const usd = d.totals.byCurrency.find((c) => c.currency === 'USD')!;
    expect(eur.invoiceCount).toBe(3);
    expect(eur.amountNative).toBeCloseTo(364.65, 1); // 164.25+180+20.4
    expect(usd.invoiceCount).toBe(1);
    expect(usd.amountNative).toBeCloseTo(13.09, 2);
    expect(usd.vendorCount).toBe(1);
  });

  it('ranks vendors by attributed EUR, applying per-row share', () => {
    // Anthropic attributed = (164.25+180)*.3 = 103.275 (top); Google 20.4; ElevenLabs 11.12
    expect(d.byVendorEur[0].vendor).toBe('Anthropic (Claude)');
    expect(d.byVendorEur[0].attributedEur).toBeCloseTo(103.28, 1);
    expect(d.byVendorEur[0].rawEur).toBeCloseTo(344.25, 1); // raw, before attribution
  });

  it('keeps native totals per vendor+currency (pre-FX)', () => {
    const el = d.byVendorNative.find((v) => v.vendor === 'ElevenLabs')!;
    expect(el.currency).toBe('USD');
    expect(el.amountNative).toBeCloseTo(13.09, 2);
  });

  it('builds monthly series per currency (separate scales)', () => {
    const eur = d.monthlyByCurrency.find((s) => s.currency === 'EUR')!;
    expect(eur.months.map((m) => m.month)).toEqual(['2026-01', '2026-02']);
    // Jan EUR attributed: Anthropic 49.275 + Google 20.4
    expect(eur.months[0].byVendor['Anthropic (Claude)']).toBeCloseTo(49.28, 1);
    expect(eur.months[0].byVendor['Google Workspace']).toBeCloseTo(20.4, 2);
    const usd = d.monthlyByCurrency.find((s) => s.currency === 'USD')!;
    expect(usd.months).toHaveLength(1);
  });

  it('handles an empty ledger', () => {
    const e = aggregateOverview([]);
    expect(e.totals.attributedEur).toBe(0);
    expect(e.totals.blendedAttributionPct).toBe(0);
    expect(e.byVendorEur).toEqual([]);
    expect(e.monthlyByCurrency).toEqual([]);
  });
});
