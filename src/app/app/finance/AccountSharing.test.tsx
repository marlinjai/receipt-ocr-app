// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AccountSharing, { sharingMessage, type SharingActions } from './AccountSharing';
import type { ShareEntry, SharingView } from './sharing-actions';

/** The payments tab's section for sharing an account's private payments, with fake server actions. Every name is invented. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const accounts = [{ id: 'acc-1', label: 'Girokonto' }];
const share = (o: Partial<ShareEntry> = {}): ShareEntry => ({ id: 'sh-1', accountId: 'acc-1', accountLabel: 'Girokonto', otherWorkspaceId: 'ws-b', otherName: 'Privat', createdAt: '2026-10-22T08:00:00.000Z', ...o });
const view = (o: Partial<SharingView> = {}): SharingView => ({ outgoing: [], incoming: [], targets: [{ workspaceId: 'ws-b', label: 'Privat' }], canWrite: true, ...o });

function actions(o: Partial<SharingActions> = {}): SharingActions {
  return {
    shareAccountWith: vi.fn(async () => ({ ok: true as const, value: view({ outgoing: [share()] }) })),
    endAccountShare: vi.fn(async () => ({ ok: true as const, value: view() })),
    ...o,
  };
}

describe('AccountSharing', () => {
  it('shows nothing when there is nothing to share or end', () => {
    const { container } = render(<AccountSharing initial={view({ targets: [] })} accounts={accounts} actions={actions()} />);
    expect(container.innerHTML).toBe('');
  });

  it('shares an account after a confirmation, and says where its private payments go now', async () => {
    const acts = actions();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AccountSharing initial={view()} accounts={accounts} actions={acts} />);
    const button = screen.getByRole('button', { name: 'Private Zahlungen von Girokonto weitergeben' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await userEvent.selectOptions(screen.getByLabelText('Firma für die privaten Zahlungen von Girokonto'), 'ws-b');
    await userEvent.click(button);
    expect(confirm).toHaveBeenCalled();
    expect(acts.shareAccountWith).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await userEvent.click(button);
    expect(acts.shareAccountWith).toHaveBeenCalledWith('acc-1', 'ws-b');
    expect((await screen.findByRole('status')).textContent).toContain('Girokonto: private Zahlungen gehen jetzt an Privat.');
    expect(screen.getByText(/private Zahlungen gehen an Privat/)).toBeTruthy();
  });

  it('ends a share from either side and shows a refusal where it happened', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const acts = actions({ endAccountShare: vi.fn(async () => ({ ok: false as const, error: 'not_found' as const, detail: 'share_not_found' })) });
    render(<AccountSharing initial={view({ incoming: [share({ id: 'sh-2', accountLabel: 'Kreditkarte', otherName: 'Firma' })] })} accounts={[]} actions={acts} />);
    expect(screen.getByText(/Kreditkarte, geführt von Firma/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Weitergabe von Kreditkarte beenden' }));
    expect(acts.endAccountShare).toHaveBeenCalledWith('sh-2');
    expect((await screen.findByRole('alert')).textContent).toContain('Diese Weitergabe ist schon beendet');
  });

  it('is read-only without the write permission', () => {
    render(<AccountSharing initial={view({ canWrite: false, outgoing: [share()] })} accounts={accounts} actions={actions()} />);
    expect(screen.getByText(/private Zahlungen gehen an Privat/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('names a company the person is no member of any more without its name', () => {
    render(<AccountSharing initial={view({ outgoing: [share({ otherName: null })] })} accounts={accounts} actions={actions()} />);
    expect(screen.getByText(/private Zahlungen gehen an eine andere Firma/)).toBeTruthy();
  });

  it('words every refusal so a person can act on it', () => {
    expect(sharingMessage({ ok: false, error: 'forbidden' })).toContain('in beiden Firmen');
    expect(sharingMessage({ ok: false, error: 'invalid_input', detail: 'already_shared' })).toContain('schon an eine Firma');
    expect(sharingMessage({ ok: false, error: 'invalid_input', detail: 'same_company' })).toContain('diese Firma selbst');
    expect(sharingMessage({ ok: false, error: 'failed' })).toContain('noch einmal versuchen');
  });
});
