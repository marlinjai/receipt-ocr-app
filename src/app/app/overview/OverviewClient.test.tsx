// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import OverviewClient, { MONTH_COLUMN_PX } from './OverviewClient';
import type { LedgerInvoice } from '@/lib/overview/selection';

/**
 * The monthly chart keeps a readable column per month and scrolls sideways in its own panel. On production
 * (2026-10-24) two years of months in three currencies made the page 1403px wide at a 390 window.
 */

afterEach(cleanup);

/** One invoice per month from the first month on, for `count` months. Vendors and amounts are invented. */
function monthly(currency: string, vendor: string, start: string, count: number): LedgerInvoice[] {
  const [y, m] = start.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(y, m - 1 + i, 15)).toISOString().slice(0, 10);
    return { id: `${currency}-${i}`, name: null, vendor, currency, amountNative: 10 + i, fxRate: 1, businessShare: 100, date };
  });
}

function overview(invoices: LedgerInvoice[]) {
  render(<OverviewClient invoices={invoices} selections={[]} attribution={{ rules: [], defaultShare: 100 }} notes="" />);
}

describe('the monthly chart', () => {
  it('gives every currency its own sideways scroll panel as wide as its months need', () => {
    overview([...monthly('EUR', 'Beispiel Hosting', '2024-07', 28), ...monthly('USD', 'Example Cloud', '2024-09', 25), ...monthly('GBP', 'Sample Books', '2025-01', 20)]);
    for (const [currency, months] of [['EUR', 28], ['USD', 25], ['GBP', 20]] as const) {
      const panel = screen.getByRole('region', { name: `${currency} je Monat` });
      expect(panel.className).toContain('overflow-x-auto');
      expect(panel.tabIndex).toBe(0);
      const inner = panel.firstElementChild as HTMLElement;
      expect(inner.style.minWidth).toBe(`${months * MONTH_COLUMN_PX}px`);
    }
  });

  it('sits in bounded grid columns, so a long chart cannot widen the page', () => {
    overview(monthly('EUR', 'Beispiel Hosting', '2024-01', 30));
    const grid = screen.getByRole('region', { name: 'EUR je Monat' }).parentElement?.parentElement;
    expect(grid?.className).toContain('grid-cols-1');
  });

  it('asks for little width when there are only a few months', () => {
    overview(monthly('EUR', 'Beispiel Hosting', '2026-08', 3));
    const inner = screen.getByRole('region', { name: 'EUR je Monat' }).firstElementChild as HTMLElement;
    expect(inner.style.minWidth).toBe(`${3 * MONTH_COLUMN_PX}px`);
  });
});
