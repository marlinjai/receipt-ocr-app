// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { buildPurchasesOverview } from '@/lib/line-items/overview';
import PurchasesPanel from './PurchasesPanel';

afterEach(cleanup);

const receipt = (date: string, grossCents: number, lines: Array<[string, number, 'groceries' | 'drink_out' | 'deposit_discount']> | null, vendor = 'REWE') => ({
  rowId: `${vendor}-${date}`,
  date,
  vendor,
  grossCents,
  currency: 'EUR',
  fxRate: 1,
  lines: lines ? lines.map(([text, cents, kind]) => ({ text, grossCents: cents, quantity: 1, kind })) : null,
});

describe('PurchasesPanel', () => {
  it('shows the receipts\' total, what the lines explain and what they do not, per kind, item and shop', () => {
    const overview = buildPurchasesOverview(
      [receipt('2026-10-01', 500, [['Hafermilch', 179, 'groceries'], ['Pfand', 25, 'deposit_discount']]), receipt('2026-10-02', 179, [['Hafermilch', 179, 'groceries']]), receipt('2026-10-03', 1000, null, 'Tankstelle')],
      { year: 2026, month: 10 },
    );
    render(<PurchasesPanel overview={overview} />);
    expect(screen.getByText('16,79 €')).toBeTruthy();
    expect(screen.getAllByText('Nicht aufgeschlüsselt').length).toBeGreaterThan(0);
    expect(screen.getByText('2 von 3')).toBeTruthy();
    expect(screen.getByText(/Ein Beleg hat noch keine Positionen/)).toBeTruthy();
    expect(screen.getByText('2 mal, 3,58 €')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Nach Händler' }).textContent).toContain('REWE');
    expect(screen.queryByRole('region', { name: 'Nach Monat' })).toBeNull();
  });

  it('says so when the period has no receipts', () => {
    render(<PurchasesPanel overview={buildPurchasesOverview([], { year: 2026, month: 3 })} />);
    expect(screen.getByText(/In März 2026 gibt es in diesem Arbeitsbereich keine Belege/)).toBeTruthy();
  });

  it('names the receipts that wait for an amount instead of saying there are none', () => {
    render(<PurchasesPanel overview={buildPurchasesOverview([{ ...receipt('2026-03-02', 0, null), grossCents: null }], { year: 2026, month: 3 })} />);
    expect(screen.getByText(/wartet ein Beleg auf einen Betrag/)).toBeTruthy();
  });

  it('a whole year shows month by month', () => {
    render(<PurchasesPanel overview={buildPurchasesOverview([receipt('2026-01-05', 300, [['Brot', 300, 'groceries']]), receipt('2026-02-05', 400, [['Kaffee', 400, 'drink_out']])], { year: 2026, month: null })} />);
    const months = screen.getByRole('region', { name: 'Nach Monat' });
    expect(months.textContent).toContain('Januar');
    expect(months.textContent).toContain('Februar');
  });
});
