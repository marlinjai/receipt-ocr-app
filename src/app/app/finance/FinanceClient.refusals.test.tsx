// @vitest-environment jsdom
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { setupUser } from '../../../../test/user';
import { afterLink, fullStatement } from './__tests__/statement-fixture';
import type { SharingActions } from './AccountSharing';
import type { BankActions } from './BankConnection';
import type { SharingView } from './sharing-actions';
import type { Result } from './actions';

/**
 * A finance write refused after the person left the page: before, the refusal went
 * with the page and the person, who believes the change went through, was never told.
 */

const actions = vi.hoisted(() => ({ confirmPaymentLink: vi.fn(), getStatement: vi.fn(), searchPayments: vi.fn(async () => ({ ok: true, value: { payments: [], total: 0 } })) }));
vi.mock('./actions', async () => actions);
vi.mock('./income-tax-actions', () => ({}));
vi.mock('./own-names-actions', () => ({}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => '/app/finance' }));
vi.mock('@/app/app/nav-actions', () => ({ getNavCounts: vi.fn(async () => ({ ok: false })) }));

import Refusals from '@/components/Refusals';
import { AppStore } from '@/stores/AppStore';
import { RefusalDesk } from '@/stores/RefusalDesk';
import { AppStoreContext, RefusalDeskContext, useFinanceRefusal } from '@/stores/provider';
import AccountSharing from './AccountSharing';
import { useBankFeed } from './BankConnection';
import FinanceClient from './FinanceClient';

beforeEach(() => {
  actions.confirmPaymentLink.mockReset();
  actions.getStatement.mockReset();
  window.history.replaceState(null, '', '/app/finance');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The shell as the layout has it: the desk above, the store of one company, its `Refusals`, and the page that can close. */
function Shell({ app, desk, page }: { app: AppStore; desk: RefusalDesk; page: ReactNode }) {
  return (
    <RefusalDeskContext.Provider value={desk}>
      <AppStoreContext.Provider value={app}>
        <Refusals />
        {page}
      </AppStoreContext.Provider>
    </RefusalDeskContext.Provider>
  );
}

const shell = () => screen.queryAllByRole('alert').map((a) => a.textContent);
const link = (user: ReturnType<typeof setupUser>) => user.click(screen.getAllByRole('button', { name: /bestätigen|Zuordnen/ })[0]);

function linkOut() {
  let answer: (v: unknown) => void = () => {};
  actions.confirmPaymentLink.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
  return (v: unknown) => act(async () => answer(v));
}

describe('a refusal that arrives after the finance page closed', () => {
  it('is said in the shell, named as finance, and stays until it is closed', async () => {
    const user = setupUser();
    const app = new AppStore();
    const desk = new RefusalDesk();
    const answer = linkOut();
    const { rerender } = render(<Shell app={app} desk={desk} page={<FinanceClient initial={fullStatement()} initialTab="questions" />} />);
    await link(user);
    rerender(<Shell app={app} desk={desk} page={null} />);
    expect(screen.queryByRole('heading', { name: 'Finanzen' })).toBeNull();
    await answer({ ok: false, error: 'forbidden' });
    expect(shell()).toEqual([expect.stringContaining('Finanzen: Für diesen Arbeitsbereich fehlt die Berechtigung zum Speichern.')]);
    await user.click(screen.getByRole('button', { name: /schließen/i }));
    expect(shell()).toEqual([]);
  });

  it('is said in the shell when the request itself failed', async () => {
    const user = setupUser();
    const app = new AppStore();
    let fail: (e: unknown) => void = () => {};
    actions.confirmPaymentLink.mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)));
    const { rerender } = render(<Shell app={app} desk={new RefusalDesk()} page={<FinanceClient initial={fullStatement()} initialTab="questions" />} />);
    await link(user);
    rerender(<Shell app={app} desk={new RefusalDesk()} page={null} />);
    await act(async () => fail(new Error('offline')));
    expect(app.looseRefusals).toHaveLength(1);
    expect(app.looseRefusals[0].who).toBe('Finanzen');
  });

  it('says nothing in the shell when the write went through', async () => {
    const user = setupUser();
    const app = new AppStore();
    const answer = linkOut();
    const { rerender } = render(<Shell app={app} desk={new RefusalDesk()} page={<FinanceClient initial={fullStatement()} initialTab="questions" />} />);
    await link(user);
    rerender(<Shell app={app} desk={new RefusalDesk()} page={null} />);
    await answer({ ok: true, value: { view: afterLink(), moved: false } });
    expect(app.looseRefusals).toEqual([]);
  });

  it('with the page still open stands on the page only, not twice', async () => {
    const user = setupUser();
    const app = new AppStore();
    const answer = linkOut();
    render(<Shell app={app} desk={new RefusalDesk()} page={<FinanceClient initial={fullStatement()} initialTab="questions" />} />);
    await link(user);
    await answer({ ok: false, error: 'forbidden' });
    expect(screen.getAllByText(/fehlt die Berechtigung zum Speichern/)).toHaveLength(1);
    expect(app.looseRefusals).toEqual([]);
  });

  it('asks no question over another page: a link refused for an already paid receipt is said in the shell instead', async () => {
    const user = setupUser();
    const app = new AppStore();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const answer = linkOut();
    const { rerender } = render(<Shell app={app} desk={new RefusalDesk()} page={<FinanceClient initial={fullStatement()} initialTab="questions" />} />);
    await link(user);
    rerender(<Shell app={app} desk={new RefusalDesk()} page={null} />);
    await answer({ ok: false, error: 'invalid_input', detail: 'receipt_already_paid:5000:5000' });
    expect(confirm).not.toHaveBeenCalled();
    expect(actions.confirmPaymentLink).toHaveBeenCalledTimes(1);
    expect(shell()).toEqual([expect.stringContaining('Nichts zugeordnet: der Beleg hat schon eine Zahlung.')]);
  });

  it('of a company the person has left goes to the desk with that company name', async () => {
    const user = setupUser();
    const app = new AppStore();
    const desk = new RefusalDesk();
    const answer = linkOut();
    const { rerender } = render(<Shell app={app} desk={desk} page={<FinanceClient initial={fullStatement()} initialTab="questions" />} />);
    await link(user);
    // The company switch: the provider keyed by company throws its store away, and the next company's takes its place.
    app.leave((refusal) => desk.take('Alpha', refusal));
    rerender(<Shell app={new AppStore()} desk={desk} page={null} />);
    await answer({ ok: false, error: 'forbidden' });
    expect(shell()).toEqual([expect.stringContaining('Firma Alpha: Finanzen: Für diesen Arbeitsbereich fehlt die Berechtigung')]);
  });
});

describe('the sections of finance with answers of their own', () => {
  it('a sharing refused after its section closed is said in the shell', async () => {
    const user = setupUser();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let answer: (v: Result<SharingView>) => void = () => {};
    const sharing: SharingActions = {
      shareAccountWith: vi.fn(() => new Promise<Result<SharingView>>((resolve) => (answer = resolve))),
      endAccountShare: vi.fn(),
    };
    const view: SharingView = { readAt: 1, outgoing: [], incoming: [], targets: [{ workspaceId: 'ws-b', label: 'Privat' }], canWrite: true };
    const app = new AppStore();
    const Page = ({ open }: { open: boolean }) => {
      const [held, setHeld] = useState(view);
      return open ? <AccountSharing view={held} onChange={setHeld} accounts={[{ id: 'acc-1', label: 'Girokonto' }]} actions={sharing} /> : null;
    };
    const { rerender } = render(<Shell app={app} desk={new RefusalDesk()} page={<Page open />} />);
    await user.selectOptions(screen.getByLabelText('Firma für die privaten Zahlungen von Girokonto'), 'ws-b');
    await user.click(screen.getByRole('button', { name: 'Private Zahlungen weitergeben: Girokonto' }));
    rerender(<Shell app={app} desk={new RefusalDesk()} page={<Page open={false} />} />);
    await act(async () => answer({ ok: false, error: 'not_found', detail: 'account_not_found' }));
    expect(shell()).toEqual([expect.stringContaining('Finanzen, private Zahlungen in einer anderen Firma: Dieses Konto gibt es in dieser Firma nicht mehr.')]);
  });

  it('a bank action refused after the page closed is said in the shell', async () => {
    const app = new AppStore();
    let answer: (v: unknown) => void = () => {};
    const bank = {
      syncBankNow: vi.fn(() => new Promise((resolve) => (answer = resolve as (v: unknown) => void))),
    } as unknown as BankActions;
    const wrapper = ({ children }: { children: ReactNode }) => <AppStoreContext.Provider value={app}>{children}</AppStoreContext.Provider>;
    const { result, unmount } = renderHook(() => useBankFeed({ readAt: 1, enabled: true, connections: [] }, 2026, bank, vi.fn(), vi.fn(), vi.fn(), useFinanceRefusal()), { wrapper });
    act(() => result.current.sync('acc-1', 'conn-1'));
    unmount();
    await act(async () => answer({ ok: false, error: 'failed' }));
    expect(app.looseRefusals).toEqual([expect.objectContaining({ who: 'Finanzen, Bankverbindung' })]);
  });
});
