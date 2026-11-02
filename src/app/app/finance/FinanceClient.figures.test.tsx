// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { setupUser, type TestUser } from '../../../../test/user';
import { afterLink, bankView, fullStatement, ownNamesView, sharingView } from './__tests__/statement-fixture';

/**
 * What every tab shows of a realistic year, before and after the move to the
 * store. The files under `__tests__/figures` were written by this test on the
 * code from before the move, and a figure, a form line or a word that comes out
 * differently fails here. Ids React makes up are left out; nothing else is.
 */

const actions = vi.hoisted(() => ({ confirmPaymentLink: vi.fn(), searchPayments: vi.fn(async () => ({ ok: true, value: { payments: [], total: 0 } })) }));
vi.mock('./actions', async () => actions);
vi.mock('./income-tax-actions', () => ({}));
vi.mock('./own-names-actions', () => ({}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import FinanceClient from './FinanceClient';

const TABS = [
  ['Erledigen', 'Offen', 'open'],
  ['Erledigen', 'Zahlungen klären', 'questions'],
  ['Auswerten', 'EÜR', 'statement'],
  ['Auswerten', 'Einnahmen', 'revenue'],
  ['Auswerten', 'Zahlungen', 'payments'],
  ['Auswerten', 'Anlagen', 'assets'],
  ['Steuer', 'Umsatzsteuer', 'vat'],
  ['Steuer', 'Einkommensteuer', 'tax'],
  ['Einstellungen', 'Konten', 'accounts'],
  ['Einstellungen', 'Lieferanten', 'vendors'],
  ['Einstellungen', 'Eigene Namen', 'names'],
] as const;

/** The page as markup, one element to a line, so a difference in the files reads as a difference in the page. */
function page(): string {
  const main = screen.getByRole('main');
  return main.outerHTML
    .replace(/ (id|for|aria-controls|aria-labelledby|aria-describedby|name)="[^"]*"/g, '')
    .replace(/></g, '>\n<');
}

async function open(user: TestUser, group: string, tab: string) {
  await user.click(screen.getByRole('tab', { name: new RegExp(`^${group}`) }));
  await user.click(within(screen.getByRole('tablist', { name: `Reiter in ${group}` })).getByRole('tab', { name: new RegExp(`^${tab}(,|$|\\s*\\d)`) }));
}

const props = { bank: bankView, sharing: sharingView, ownNames: ownNamesView };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-02T10:00:00Z'));
  window.history.replaceState(null, '', '/app/finance');
  actions.confirmPaymentLink.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('every tab of a realistic year', () => {
  it.each(TABS)('%s, %s', async (group, tab, file) => {
    const user = setupUser();
    render(<FinanceClient initial={fullStatement()} {...props} />);
    await open(user, group, tab);
    await waitFor(() => expect(actions.searchPayments.mock.results.every((r) => r.type === 'return')).toBe(true));
    await expect(page()).toMatchFileSnapshot(`__tests__/figures/${file}.html`);
  });

  it('the statement with a line open, its receipts beside their shares, one of them in its form', async () => {
    const user = setupUser();
    render(<FinanceClient initial={fullStatement()} {...props} />);
    await open(user, 'Auswerten', 'EÜR');
    await user.click(screen.getByRole('button', { name: /Telekommunikation/ }));
    expect(screen.getByText(/Router/)).toBeTruthy();
    await expect(page()).toMatchFileSnapshot('__tests__/figures/statement-receipts.html');
    await user.click(screen.getAllByRole('button', { name: 'Ändern' })[0]);
    await expect(page()).toMatchFileSnapshot('__tests__/figures/statement-form.html');
  });

  it('the statement with the line of an asset open', async () => {
    const user = setupUser();
    render(<FinanceClient initial={fullStatement()} {...props} />);
    await open(user, 'Auswerten', 'EÜR');
    await user.click(screen.getByRole('button', { name: /AfA auf bewegliche/ }));
    expect(screen.getByText(/Kamera/)).toBeTruthy();
    await expect(page()).toMatchFileSnapshot('__tests__/figures/statement-asset.html');
  });
});

describe('a change that shows on several tabs', () => {
  it('after linking a payment every tab reads as a fresh page of the new year does', async () => {
    const user = setupUser();
    actions.confirmPaymentLink.mockResolvedValue({ ok: true, value: { view: afterLink(), moved: false } });
    const { unmount } = render(<FinanceClient initial={fullStatement()} {...props} />);
    await open(user, 'Erledigen', 'Zahlungen klären');
    await user.click(screen.getAllByRole('button', { name: /bestätigen|Zuordnen/ })[0]);
    await screen.findByText('Zahlung zugeordnet.');
    expect(actions.confirmPaymentLink).toHaveBeenCalledTimes(1);
    const answered: Record<string, string> = {};
    for (const [group, tab, file] of TABS) {
      await open(user, group, tab);
      answered[file] = page();
    }
    unmount();
    render(<FinanceClient initial={afterLink()} {...props} />);
    for (const [group, tab, file] of TABS) {
      await open(user, group, tab);
      expect(page()).toBe(answered[file]);
    }
    // The change did reach the page, or this compares two copies of nothing.
    expect(answered.statement).toContain('565,25 €');
    expect(answered.statement).not.toContain('446,25 €');
  });
});
