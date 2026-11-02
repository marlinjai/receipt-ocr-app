// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { setupUser, type TestUser } from '../../../../test/user';
import type { BankActions } from './BankConnection';
import { afterLink, bankView, fullStatement, sharingView } from './__tests__/statement-fixture';

/** The page on its store: what one source means when answers overlap, the year changes and the page is entered again. */

const actions = vi.hoisted(() => ({ confirmPaymentLink: vi.fn(), searchPayments: vi.fn(async () => ({ ok: true, value: { payments: [], total: 0 } })) }));
vi.mock('./actions', async () => actions);
vi.mock('./income-tax-actions', () => ({}));
vi.mock('./own-names-actions', () => ({}));
const drawn = vi.hoisted(() => ({ days: [] as string[] }));
vi.mock('@/lib/meals/messages', async (original) => {
  const real = await original<typeof import('@/lib/meals/messages')>();
  return {
    ...real,
    formatDay: (day: string) => {
      drawn.days.push(day);
      return real.formatDay(day);
    },
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import FinanceClient from './FinanceClient';

const tile = (label: RegExp) => screen.getByText(label).parentElement!.textContent;
const expenses = () => tile(/^Betriebsausgaben/);

async function open(user: TestUser, group: string, tab: string) {
  await user.click(screen.getByRole('tab', { name: new RegExp(`^${group}`) }));
  await user.click(within(screen.getByRole('tablist', { name: `Reiter in ${group}` })).getByRole('tab', { name: new RegExp(`^${tab}(,|$|\\s*\\d)`) }));
}

const link = (user: TestUser) => user.click(screen.getAllByRole('button', { name: /bestätigen|Zuordnen/ })[0]);

beforeEach(() => {
  actions.confirmPaymentLink.mockReset();
  window.history.replaceState(null, '', '/app/finance');
});
afterEach(cleanup);

describe('forward: a write shows everywhere its answer reaches', () => {
  it('the tile above, the count on the tab and the other tabs read the one new statement', async () => {
    const user = setupUser();
    actions.confirmPaymentLink.mockResolvedValue({ ok: true, value: { view: afterLink(), moved: false } });
    render(<FinanceClient initial={fullStatement()} initialTab="questions" />);
    expect(expenses()).toContain('446,25 €');
    expect(screen.getByRole('tab', { name: /^Erledigen/ }).textContent).toBe('Erledigen, 9 offen');
    await link(user);
    await screen.findByText('Zahlung zugeordnet.');
    expect(expenses()).toContain('565,25 €');
    // Four receipts, one overdue invoice, one open payment and one counterparty; before the link it was nine.
    expect(screen.getByRole('tab', { name: /^Erledigen/ }).textContent).toBe('Erledigen, 7 offen');
    await open(user, 'Auswerten', 'Zahlungen');
    expect(screen.getByText(/Rechnung tel-1/)).toBeTruthy();
  });
});

describe('going back: the year changes while an answer is out', () => {
  it('the answer of the year left does not show in the year opened', async () => {
    const user = setupUser();
    let answer: (v: unknown) => void = () => {};
    actions.confirmPaymentLink.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const other = { ...fullStatement(), year: 2024, readAt: 3, businessExpenseCents: 100 };
    const { rerender } = render(<FinanceClient initial={fullStatement()} initialTab="questions" />);
    await link(user);
    rerender(<FinanceClient initial={other} initialTab="questions" />);
    expect(expenses()).toContain('1,00 €');
    await act(async () => answer({ ok: true, value: { view: afterLink(), moved: false } }));
    expect(expenses()).toContain('1,00 €');
    expect(screen.getByRole('combobox', { name: 'Jahr' })).toHaveProperty('value', '2024');
  });

  it('another year starts from what the server sends, with the bank fresh', async () => {
    const offline = { ...bankView, enabled: false };
    const { rerender } = render(<FinanceClient initial={fullStatement()} initialTab="accounts" bank={bankView} sharing={sharingView} />);
    expect(screen.queryByText(/Live-Anbindung an Banken ist auf diesem Server nicht eingeschaltet/)).toBeNull();
    rerender(<FinanceClient initial={{ ...fullStatement(), year: 2024 }} initialTab="accounts" bank={offline} sharing={sharingView} />);
    expect(screen.getAllByText(/Live-Anbindung an Banken ist auf diesem Server nicht eingeschaltet/).length).toBeGreaterThan(0);
  });
});

describe('overlapping answers', () => {
  it('a bank sync answering after a newer write cannot bring the old year back', async () => {
    const user = setupUser();
    let syncAnswer: (v: unknown) => void = () => {};
    const bankActions = { syncBankNow: vi.fn(() => new Promise((resolve) => (syncAnswer = resolve))) } as unknown as BankActions;
    actions.confirmPaymentLink.mockResolvedValue({ ok: true, value: { view: { ...afterLink(), readAt: 9 }, moved: false } });
    render(<FinanceClient initial={fullStatement()} initialTab="accounts" bank={bankView} bankActions={bankActions} />);
    await user.click(screen.getByRole('button', { name: 'Jetzt abholen' }));
    await open(user, 'Erledigen', 'Zahlungen klären');
    await link(user);
    await screen.findByText('Zahlung zugeordnet.');
    await act(async () => syncAnswer({ ok: true, value: { bank: bankView, view: { ...fullStatement(), readAt: 4 }, outcome: { status: 'nothing_new' } } }));
    expect(expenses()).toContain('565,25 €');
  });
});

describe('resume: the page is opened again', () => {
  it('a later read of the same year takes its place, an older one does not', () => {
    const { rerender } = render(<FinanceClient initial={fullStatement()} />);
    rerender(<FinanceClient initial={afterLink()} />);
    expect(expenses()).toContain('565,25 €');
    rerender(<FinanceClient initial={fullStatement()} />);
    expect(expenses()).toContain('565,25 €');
  });

  it('a new visit starts from its own read', () => {
    const { unmount } = render(<FinanceClient initial={afterLink()} />);
    unmount();
    render(<FinanceClient initial={fullStatement()} />);
    expect(expenses()).toContain('446,25 €');
  });
});

describe('re-entry after a failed write', () => {
  it('a refused link changes no figure, and the same link can be sent again', async () => {
    const user = setupUser();
    actions.confirmPaymentLink.mockResolvedValueOnce({ ok: false, error: 'forbidden' }).mockResolvedValueOnce({ ok: true, value: { view: afterLink(), moved: false } });
    render(<FinanceClient initial={fullStatement()} initialTab="questions" />);
    await link(user);
    await screen.findByRole('alert');
    expect(expenses()).toContain('446,25 €');
    await vi.waitFor(() => expect((screen.getAllByRole('button', { name: /bestätigen|Zuordnen/ })[0] as HTMLButtonElement).disabled).toBe(false));
    await link(user);
    await screen.findByText('Zahlung zugeordnet.');
    expect(expenses()).toContain('565,25 €');
  });
});

describe('rows redraw by record', () => {
  it('a new year on screen takes one receipt out of the queue and leaves the rows of the others as drawn', () => {
    const { rerender } = render(<FinanceClient initial={fullStatement()} initialTab="open" />);
    // The day this row alone shows: drawn again means the row was.
    expect(drawn.days).toContain('2026-01-04');
    drawn.days.length = 0;
    rerender(<FinanceClient initial={afterLink()} initialTab="open" />);
    expect(screen.queryByRole('button', { name: /Kanzlei Beispiel/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Vermieter Beispiel/ })).toBeTruthy();
    expect(drawn.days).not.toContain('2026-01-04');
  });
});
