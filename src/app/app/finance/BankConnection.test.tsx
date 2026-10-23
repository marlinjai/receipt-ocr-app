// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BankConnectionView } from '@/lib/tax/payments/bank/service';
import type { StatementView } from '@/lib/tax/service';
import { BankAccountStatus, useBankFeed, type BankActions } from './BankConnection';
import type { BankView } from './bank-actions';

/** The bank controls of one account, with fake server actions. Every name is invented. */

afterEach(cleanup);

const account = { id: 'acc-1', label: 'N26 privat' };
const connection = (o: Partial<BankConnectionView> = {}): BankConnectionView => ({
  id: 'con-1',
  accountId: 'acc-1',
  status: 'active',
  aspspName: 'N26',
  pendingAspspName: null,
  validUntil: '2027-01-14T08:00:00.000Z',
  renewSoon: false,
  lastSyncedAt: '2026-10-16T06:00:00.000Z',
  lastBookedThrough: '2026-10-15',
  lastError: null,
  lastErrorAt: null,
  notices: { gaps: [], skipped: [], undated: [], unrated: [] },
  candidates: [],
  accountUid: 'uid-1',
  boundMask: null,
  boundName: null,
  ...o,
});

function actions(o: Partial<BankActions> = {}): BankActions {
  return {
    listBankInstitutions: vi.fn(async () => ({ ok: true as const, value: [{ name: 'Beispielbank', country: 'DE', beta: false }, { name: 'N26', country: 'DE', beta: false }] })),
    startBankConsent: vi.fn(async () => ({ ok: true as const, value: { url: 'https://bank.example.test/consent' } })),
    chooseBankConnectionAccount: vi.fn(async () => ({ ok: true as const, value: { enabled: true, connections: [] } })),
    syncBankNow: vi.fn(async () => ({ ok: true as const, value: { bank: { enabled: true, connections: [connection()] }, view: { year: 2026 } as StatementView, outcome: { status: 'synced', added: 3 } } })),
    disconnectBank: vi.fn(async () => ({ ok: true as const, value: { bank: { enabled: true, connections: [] }, closedAtBank: true } })),
    clearBankConnectionNotice: vi.fn(async () => ({ ok: true as const, value: { enabled: true, connections: [connection()] } })),
    ...o,
  };
}

function Harness({ bank, acts, go = vi.fn(), onStatement = vi.fn() }: { bank: BankView; acts: BankActions; go?: (url: string) => void; onStatement?: (v: StatementView) => void }) {
  const feed = useBankFeed(bank, 2026, acts, onStatement, go);
  return <BankAccountStatus account={account} feed={feed} actions={acts} enabled={feed.bank.enabled} />;
}

describe('BankAccountStatus', () => {
  it('an account without a connection says "Datei-Import" and connects through the institution picker', async () => {
    const acts = actions();
    const go = vi.fn();
    render(<Harness bank={{ enabled: true, connections: [] }} acts={acts} go={go} />);
    expect(screen.getByText('Datei-Import')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Live mit der Bank verbinden' }));
    // Preselected from the account's label.
    expect((screen.getByLabelText('Bank') as HTMLSelectElement).value).toBe('N26');
    await userEvent.click(screen.getByRole('button', { name: 'Weiter zur Bank' }));
    expect(acts.startBankConsent).toHaveBeenCalledWith('acc-1', { name: 'N26', country: 'DE' });
    expect(go).toHaveBeenCalledWith('https://bank.example.test/consent');
  });

  it('an institution the interface refuses says the account stays on its file importer', async () => {
    const acts = actions({ startBankConsent: vi.fn(async () => ({ ok: false as const, error: 'invalid_input' as const, detail: 'aspsp_not_offered' })) });
    render(<Harness bank={{ enabled: true, connections: [] }} acts={acts} />);
    await userEvent.click(screen.getByRole('button', { name: 'Live mit der Bank verbinden' }));
    await userEvent.click(screen.getByRole('button', { name: 'Weiter zur Bank' }));
    expect(await screen.findByText(/bleibt beim Datei-Import/)).toBeTruthy();
  });

  it('an active connection shows when it was fetched, fetches now and reports the count', async () => {
    const acts = actions();
    const onStatement = vi.fn();
    render(<Harness bank={{ enabled: true, connections: [connection()] }} acts={acts} onStatement={onStatement} />);
    expect(screen.getByText(/Live über die Bankschnittstelle \(N26\), zuletzt abgeholt am 16\.10\.2026/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Jetzt abholen' }));
    expect(acts.syncBankNow).toHaveBeenCalledWith(2026, 'con-1');
    expect(await screen.findByText('3 neue Zahlungen abgeholt.')).toBeTruthy();
    expect(onStatement).toHaveBeenCalled();
  });

  it('warns before the consent runs out', () => {
    render(<Harness bank={{ enabled: true, connections: [connection({ renewSoon: true })] }} acts={actions()} />);
    expect(screen.getByText(/läuft am 14\.01\.2027 ab/)).toBeTruthy();
  });

  it('an expired connection is stale with its last complete day and offers renewal', () => {
    render(<Harness bank={{ enabled: true, connections: [connection({ status: 'expired' })] }} acts={actions()} />);
    expect(screen.getByText(/Verbindung abgelaufen am 14\.01\.2027, bitte erneuern\. Vollständig bis 15\.10\.2026/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Jetzt abholen' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Freigabe erneuern' })).toBeTruthy();
  });

  it('a failed connection says why', () => {
    render(<Harness bank={{ enabled: true, connections: [connection({ status: 'error', lastError: 'consent_refused' })] }} acts={actions()} />);
    expect(screen.getByText(/Fehler: Die Freigabe wurde bei der Bank abgebrochen/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Neu starten' })).toBeTruthy();
  });

  it('several accounts of the session are offered to choose from', async () => {
    const acts = actions();
    const c = connection({ status: 'choose_account', accountUid: null, candidates: [{ uid: 'u1', mask: '•••• 1111', name: 'Girokonto', currency: 'EUR' }, { uid: 'u2', mask: '•••• 2222', name: 'Tagesgeld', currency: 'EUR' }] });
    render(<Harness bank={{ enabled: true, connections: [c] }} acts={acts} />);
    await userEvent.selectOptions(screen.getByLabelText('Welches Konto der Bank ist dieses?'), 'u2');
    await userEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));
    expect(acts.chooseBankConnectionAccount).toHaveBeenCalledWith('con-1', 'u2');
  });

  it('after a renewal a single account that is not the one read before is asked about, with a warning', async () => {
    const acts = actions();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const c = connection({ status: 'choose_account', accountUid: null, boundMask: '•••• 1111', boundName: 'Girokonto', candidates: [{ uid: 'u9', mask: '•••• 9999', name: 'Kreditkarte', currency: 'EUR' }] });
    render(<Harness bank={{ enabled: true, connections: [c] }} acts={acts} />);
    expect(screen.getByText(/bis dahin wird nichts abgeholt/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Welches Konto der Bank ist dieses?'), 'u9');
    await userEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));
    expect(confirm).toHaveBeenCalled();
    expect(acts.chooseBankConnectionAccount).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));
    expect(acts.chooseBankConnectionAccount).toHaveBeenCalledWith('con-1', 'u9');
    confirm.mockRestore();
  });

  it('the selection follows the bound account after a choice', async () => {
    const two = [{ uid: 'u1', mask: '•••• 1111', name: 'Girokonto', currency: 'EUR' }, { uid: 'u2', mask: '•••• 2222', name: 'Tagesgeld', currency: 'EUR' }];
    const acts = actions({ chooseBankConnectionAccount: vi.fn(async () => ({ ok: true as const, value: { enabled: true, connections: [connection({ accountUid: 'u2', candidates: two, boundMask: '•••• 2222', boundName: 'Tagesgeld' })] } })) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Harness bank={{ enabled: true, connections: [connection({ accountUid: 'u1', candidates: two })] }} acts={acts} />);
    const select = screen.getByLabelText('Konto der Bank') as HTMLSelectElement;
    expect(select.value).toBe('u1');
    await userEvent.selectOptions(select, 'u2');
    await userEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));
    expect(await screen.findByText(/Konto übernommen/)).toBeTruthy();
    expect((screen.getByLabelText('Konto der Bank') as HTMLSelectElement).value).toBe('u2');
    expect((screen.getByRole('button', { name: 'Übernehmen' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disconnecting asks first and keeps the payments', async () => {
    const acts = actions();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Harness bank={{ enabled: true, connections: [connection()] }} acts={acts} />);
    await userEvent.click(screen.getByRole('button', { name: 'Trennen' }));
    expect(acts.disconnectBank).toHaveBeenCalledWith('con-1');
    expect(await screen.findByText(/abgeholten Zahlungen bleiben/)).toBeTruthy();
  });

  it('with the feed off there are no bank buttons', () => {
    render(<Harness bank={{ enabled: false, connections: [] }} acts={actions()} />);
    expect(screen.getByText('Datei-Import')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a gap and skipped days until the person clears each of them', async () => {
    // The server answers each clear with what is left.
    const acts = actions({
      clearBankConnectionNotice: vi
        .fn()
        .mockResolvedValueOnce({ ok: true as const, value: { enabled: true, connections: [connection({ notices: { gaps: [], skipped: ['2026-10-01'], undated: [], unrated: [] } })] } })
        .mockResolvedValueOnce({ ok: true as const, value: { enabled: true, connections: [connection()] } }),
    });
    const withNotices = connection({ notices: { gaps: [{ from: '2026-05-02', to: '2026-07-18' }], skipped: ['2026-10-01'], undated: [], unrated: [] } });
    render(<Harness bank={{ enabled: true, connections: [withNotices] }} acts={acts} />);
    expect(screen.getByText(/vom 02\.05\.2026 bis 18\.07\.2026 kann die Bank nicht mehr liefern/)).toBeTruthy();
    expect(screen.getByText(/beschreibt die Bank eine Buchung zu unvollständig/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Erledigt: Lücke vom 02.05.2026 bis 18.07.2026' }));
    expect(acts.clearBankConnectionNotice).toHaveBeenCalledWith('con-1', { kind: 'gap', from: '2026-05-02', to: '2026-07-18' });
    await userEvent.click(await screen.findByRole('button', { name: 'Erledigt: ausgelassene Buchung vom 01.10.2026' }));
    expect(acts.clearBankConnectionNotice).toHaveBeenLastCalledWith('con-1', { kind: 'skipped', day: '2026-10-01' });
    expect(await screen.findByText('Hinweis erledigt.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Erledigt/ })).toBeNull();
  });

  it('counts bookings without a day until the person clears them', async () => {
    const acts = actions();
    render(<Harness bank={{ enabled: true, connections: [connection({ notices: { gaps: [], skipped: [], undated: ['a1b2c3d4e5f6a1b2c3d4e5f6', 'f6e5d4c3b2a1f6e5d4c3b2a1'], unrated: [] } })] }} acts={acts} />);
    expect(screen.getByText(/2 Buchungen ohne lesbares Datum/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Erledigt: Buchungen ohne Datum' }));
    expect(acts.clearBankConnectionNotice).toHaveBeenCalledWith('con-1', { kind: 'undated', keys: ['a1b2c3d4e5f6a1b2c3d4e5f6', 'f6e5d4c3b2a1f6e5d4c3b2a1'] });
  });

  it('shows no notice when there is none', () => {
    render(<Harness bank={{ enabled: true, connections: [connection()] }} acts={actions()} />);
    expect(screen.queryByRole('button', { name: /^Erledigt/ })).toBeNull();
  });
});
