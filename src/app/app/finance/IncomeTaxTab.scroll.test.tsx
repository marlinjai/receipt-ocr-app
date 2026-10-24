// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { incomeTaxView } from '@/lib/tax/income-tax/__tests__/fixtures';
import type { StatementView } from '@/lib/tax/service';
import { zeroFigures, type WageEntry } from '@/lib/tax/income-tax/wages';
import IncomeTaxTab from './IncomeTaxTab';

/**
 * The two wide tables of the income tax tab (taxes, and wage statements) scroll sideways in their own box on a
 * phone, so the page never does (production measured 445px at a 390 window on 2026-10-24). A file of its own,
 * so this check does not touch the tab's main test file another branch is changing.
 */

// jsdom lays nothing out: the boxes report a table wider than themselves, as on a phone.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(433);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(313);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const slip = (month: number): WageEntry => ({
  id: `w-${month}`,
  employer: 'Arbeitgeber mit einem recht langen Namen',
  month,
  healthWithSickPay: true,
  churchLiable: null,
  ...zeroFigures(),
  grossCents: 450_000,
  wageTaxCents: 70_000,
});

const view = (incomeTax = incomeTaxView()): StatementView => ({ year: incomeTax.year, employmentCostCents: 0, incomeTax }) as StatementView;
const props = { busy: false, error: null, onSaveWage: vi.fn(), onRemoveWage: vi.fn(), onSaveItem: vi.fn(), onRemoveItem: vi.fn(), onChurchMonths: vi.fn(), onFederalState: vi.fn() };

describe('the income tax tables', () => {
  // jsdom applies no CSS: this checks the boxes are there and reachable; the sticky column and the one-line
  // amounts were checked in the browser at 360 and 390 (plan, follow-up section).
  it('puts the taxes table and the wage table each in its own named, focusable scroll box', () => {
    const tax = incomeTaxView({ year: 2025, profitCents: 100_000, wageEntries: [slip(1), slip(2)], federalState: 'BE' });
    render(<IncomeTaxTab view={view(tax)} {...props} />);
    for (const name of [/Steuern 2025/, /Lohnangaben 2025/]) {
      const box = screen.getByRole('table', { name }).parentElement as HTMLElement;
      expect(box.className).toBe('ui-table-scroll');
      expect(box.getAttribute('role')).toBe('region');
      expect(box.getAttribute('aria-label')).toMatch(name);
      expect(box.tabIndex).toBe(0);
    }
  });
});
