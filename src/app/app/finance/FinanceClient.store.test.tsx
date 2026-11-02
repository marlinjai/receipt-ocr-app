// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { setupUser, type TestUser } from '../../../../test/user';
import type { BankActions } from './BankConnection';
import { afterLink, bankView, fullStatement, ownNamesView, sharingView } from './__tests__/statement-fixture';

/** The page on its store: what one source means when answers overlap, the year changes and the page is entered again. */

const actions = vi.hoisted(() => ({ confirmPaymentLink: vi.fn(), getStatement: vi.fn(), searchPayments: vi.fn(async () => ({ ok: true, value: { payments: [], total: 0 } })) }));
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
  actions.getStatement.mockReset();
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

describe('no figure older than a write the person was told finished', () => {
  const year2024 = (readAt: number, businessExpenseCents = 100) => ({ ...fullStatement(), year: 2024, readAt, businessExpenseCents });

  it('there and back while the answer is out: the answer reaches the year, whatever the read from before it says', async () => {
    const user = setupUser();
    let answer: (v: unknown) => void = () => {};
    actions.confirmPaymentLink.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { rerender } = render(<FinanceClient initial={fullStatement()} initialTab="questions" />);
    await link(user);
    rerender(<FinanceClient initial={year2024(3)} initialTab="questions" />);
    // The way back was read before the write reached the database.
    rerender(<FinanceClient initial={{ ...fullStatement(), readAt: 4 }} initialTab="questions" />);
    expect(expenses()).toContain('446,25 €');
    await act(async () => answer({ ok: true, value: { view: { ...afterLink(), readAt: 9 }, moved: false } }));
    expect(expenses()).toContain('565,25 €');
  });

  it('a bank sync there and back too, with what it says about the connection', async () => {
    const user = setupUser();
    let answer: (v: unknown) => void = () => {};
    const bankActions = { syncBankNow: vi.fn(() => new Promise((resolve) => (answer = resolve))) } as unknown as BankActions;
    const { rerender } = render(<FinanceClient initial={fullStatement()} initialTab="accounts" bank={bankView} bankActions={bankActions} />);
    await user.click(screen.getByRole('button', { name: 'Jetzt abholen' }));
    rerender(<FinanceClient initial={year2024(3)} initialTab="accounts" bank={bankView} bankActions={bankActions} />);
    rerender(<FinanceClient initial={{ ...fullStatement(), readAt: 4 }} initialTab="accounts" bank={bankView} bankActions={bankActions} />);
    const synced = { ...bankView, readAt: 9, connections: [{ ...bankView.connections[0], lastSyncedAt: '2026-01-02T06:00:00.000Z' }] };
    await act(async () => answer({ ok: true, value: { bank: synced, view: { ...afterLink(), readAt: 9 }, outcome: { status: 'synced', added: 2 } } }));
    expect(expenses()).toContain('565,25 €');
    expect(screen.getByText(/zuletzt abgeholt am 02\.01\.2026/)).toBeTruthy();
  });

  it('a write that ends while another year is open has that year read again: it can reach across years', async () => {
    const user = setupUser();
    let answer: (v: unknown) => void = () => {};
    actions.confirmPaymentLink.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    actions.getStatement.mockResolvedValue({ ok: true, value: year2024(10, 200) });
    const { rerender } = render(<FinanceClient initial={fullStatement()} initialTab="questions" />);
    await link(user);
    rerender(<FinanceClient initial={year2024(3)} initialTab="questions" />);
    await act(async () => answer({ ok: true, value: { view: { ...afterLink(), readAt: 9 }, moved: false } }));
    expect(actions.getStatement).toHaveBeenCalledWith(2024);
    expect(expenses()).toContain('2,00 €');
  });

  it('a year opened from a read older than the write is read again', async () => {
    const user = setupUser();
    actions.confirmPaymentLink.mockResolvedValue({ ok: true, value: { view: { ...afterLink(), readAt: 9 }, moved: false } });
    actions.getStatement.mockResolvedValue({ ok: true, value: year2024(10, 200) });
    const { rerender } = render(<FinanceClient initial={fullStatement()} initialTab="questions" />);
    await link(user);
    await screen.findByText('Zahlung zugeordnet.');
    rerender(<FinanceClient initial={year2024(3)} initialTab="questions" />);
    await vi.waitFor(() => expect(expenses()).toContain('2,00 €'));
  });

  it('a year read after the write is believed, and asks nothing', async () => {
    const user = setupUser();
    actions.confirmPaymentLink.mockResolvedValue({ ok: true, value: { view: { ...afterLink(), readAt: 9 }, moved: false } });
    const { rerender } = render(<FinanceClient initial={fullStatement()} initialTab="questions" />);
    await link(user);
    await screen.findByText('Zahlung zugeordnet.');
    rerender(<FinanceClient initial={year2024(12)} initialTab="questions" />);
    expect(expenses()).toContain('1,00 €');
    expect(actions.getStatement).not.toHaveBeenCalled();
  });

  it('when that second read fails it says so, instead of standing beside old figures', async () => {
    const user = setupUser();
    let answer: (v: unknown) => void = () => {};
    actions.confirmPaymentLink.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    actions.getStatement.mockRejectedValue(new Error('offline'));
    const { rerender } = render(<FinanceClient initial={fullStatement()} initialTab="questions" />);
    await link(user);
    rerender(<FinanceClient initial={year2024(3)} initialTab="questions" />);
    await act(async () => answer({ ok: true, value: { view: { ...afterLink(), readAt: 9 }, moved: false } }));
    expect((await screen.findByRole('alert')).textContent).toContain('bitte die Seite neu laden');
  });
});

describe('the same year read again', () => {
  const unshared = { ...sharingView, targets: [], readAt: 1 };
  const shared = { ...sharingView, readAt: 5, targets: [{ workspaceId: 'ws-3', label: 'Dritte Firma' }] };

  it('refreshes the sharing, the bank connections and the own names with the statement', () => {
    const page = (statement: ReturnType<typeof fullStatement>, o: object) => <FinanceClient initial={statement} initialTab="accounts" bank={bankView} sharing={unshared} ownNames={ownNamesView} {...o} />;
    const { rerender } = render(page(fullStatement(), {}));
    expect(screen.queryByText(/Dritte Firma/)).toBeNull();
    const later = { ...bankView, readAt: 5, connections: [{ ...bankView.connections[0], aspspName: 'Neue Bank' }] };
    rerender(page({ ...fullStatement(), readAt: 5 }, { sharing: shared, bank: later, ownNames: { ...ownNamesView, readAt: 5, names: ['Neuer Name'] } }));
    expect(screen.getAllByText(/Dritte Firma/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Neue Bank/)).toBeTruthy();
  });

  it('shows the names it read', async () => {
    const user = setupUser();
    const { rerender } = render(<FinanceClient initial={fullStatement()} ownNames={ownNamesView} />);
    await open(user, 'Einstellungen', 'Eigene Namen');
    rerender(<FinanceClient initial={{ ...fullStatement(), readAt: 5 }} ownNames={{ ...ownNamesView, readAt: 5, names: ['Neuer Name'] }} />);
    expect(screen.getByText('Neuer Name')).toBeTruthy();
  });

  it('an older read leaves them as they are', () => {
    const { rerender } = render(<FinanceClient initial={fullStatement()} initialTab="accounts" sharing={shared} />);
    rerender(<FinanceClient initial={{ ...fullStatement(), readAt: 2 }} initialTab="accounts" sharing={unshared} />);
    expect(screen.getAllByText(/Dritte Firma/).length).toBeGreaterThan(0);
  });

  it('a read that could not get them keeps what is there', () => {
    const { rerender } = render(<FinanceClient initial={fullStatement()} initialTab="accounts" sharing={shared} />);
    rerender(<FinanceClient initial={{ ...fullStatement(), readAt: 8 }} initialTab="accounts" sharing={null} />);
    expect(screen.getAllByText(/Dritte Firma/).length).toBeGreaterThan(0);
  });
});

describe('the own names of another year', () => {
  it('are the ones the server read with it, not what the last year held', () => {
    const { rerender } = render(<FinanceClient initial={fullStatement()} initialTab="names" ownNames={ownNamesView} />);
    expect(screen.getByText('Inhaber Beispiel')).toBeTruthy();
    rerender(<FinanceClient initial={{ ...fullStatement(), year: 2024 }} initialTab="names" ownNames={{ ...ownNamesView, names: ['Auf Spending geändert'] }} />);
    expect(screen.getByText('Auf Spending geändert')).toBeTruthy();
    expect(screen.queryByText('Inhaber Beispiel')).toBeNull();
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
