import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

/**
 * The server page turns the address into the tab the Finanzen page opens on
 * (plan 2026-10-25-finance-groups): every new `?reiter=` value, the old
 * `zahlungen`, and the return from the bank (`?bank=`) onto the accounts. The
 * reads behind it are replaced; the client page is not rendered, only its
 * props are read.
 */

vi.mock('@/lib/auth', () => ({ auth: { requireSession: vi.fn(async () => ({})) } }));
vi.mock('./actions', () => ({ getStatement: vi.fn(async () => ({ ok: true, value: { year: 2025 } })) }));
vi.mock('./bank-actions', () => ({ getBankView: vi.fn(async () => ({ ok: true, value: { enabled: true, connections: [] } })) }));
vi.mock('./sharing-actions', () => ({ getSharingView: vi.fn(async () => ({ ok: false, error: 'failed' })) }));
vi.mock('./own-names-actions', () => ({ getOwnNamesView: vi.fn(async () => ({ ok: true, value: { names: ['Erika Beispiel'], canWrite: true } })) }));
vi.mock('./FinanceClient', () => ({ default: () => null }));

import FinancePage from './page';

type Props = { initialTab?: string; bankReturn: string | null; ownNames: unknown; sharingFailed: boolean };

async function propsFor(params: { jahr?: string; reiter?: string; bank?: string }): Promise<Props> {
  const element = (await FinancePage({ searchParams: Promise.resolve(params) })) as ReactElement<Props>;
  return element.props;
}

beforeEach(() => vi.clearAllMocks());

describe('the Finanzen server page', () => {
  it('resume: a new address opens its tab, a group address its first tab, the old "zahlungen" the payment questions', async () => {
    expect((await propsFor({ reiter: 'zahlungsliste' })).initialTab).toBe('payments');
    expect((await propsFor({ reiter: 'einstellungen' })).initialTab).toBe('accounts');
    expect((await propsFor({ reiter: 'zahlungen' })).initialTab).toBe('questions');
    expect((await propsFor({})).initialTab).toBeUndefined();
    expect((await propsFor({ reiter: 'unbekannt' })).initialTab).toBeUndefined();
  });

  it('re-entry: the return from the bank opens the accounts with its outcome, whatever reiter says', async () => {
    const props = await propsFor({ reiter: 'zahlungen', bank: 'verbunden' });
    expect(props.initialTab).toBe('accounts');
    expect(props.bankReturn).toBe('verbunden');
    expect((await propsFor({ bank: 'fehler:feature_off' })).initialTab).toBe('accounts');
  });

  it('hands the own names to the page, and says when sharing could not be read', async () => {
    const props = await propsFor({});
    expect(props.ownNames).toEqual({ names: ['Erika Beispiel'], canWrite: true });
    expect(props.sharingFailed).toBe(true);
  });
});
