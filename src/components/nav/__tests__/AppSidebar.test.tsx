// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { SMALL_BUSINESS, meal } from '@/lib/meals/__tests__/fixtures';
import { NO_YEARS } from '@/lib/receipt-years';
import type { ReviewEntry } from '@/lib/review/service';
import { MealsStore } from '@/stores/MealsStore';
import { ReceiptsStore, type ReceiptsApi } from '@/stores/ReceiptsStore';
import AppSidebar from '../AppSidebar';
import { AppStoreProvider, useAppStore } from '@/stores/provider';

const nav = vi.hoisted(() => ({ pathname: '/app/finance', getNavCounts: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));
vi.mock('@/app/app/nav-actions', () => ({ getNavCounts: nav.getNavCounts }));
vi.mock('@/components/WorkspaceSwitcher', () => ({ default: () => <label>Firma<select aria-label="Active company workspace" /></label> }));
vi.mock('@/app/app/spending/PushSession', () => ({ SignOutLink: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

const session = { email: 'owner@example.test' } as never;

function receiptsStore(review: number, openMeals: number) {
  const entries = Array.from({ length: review }, (_, i) => ({ rowId: `r${i}`, duplicates: [] }) as unknown as ReviewEntry);
  return new ReceiptsStore({ tableId: 't', years: NO_YEARS, yearCounts: { years: [], undated: 0 }, review: entries, openMeals }, {} as ReceiptsApi);
}

function OpenReceipts({ store }: { store: ReceiptsStore }) {
  const app = useAppStore();
  useEffect(() => app.openReceipts(store), [app, store]);
  return null;
}

function sidebar(extra?: React.ReactNode, initialFolded = false) {
  return render(
    <AppStoreProvider>
      <AppSidebar session={session} logoutUrl="/logout" initialFolded={initialFolded} />
      {extra}
    </AppStoreProvider>,
  );
}

beforeEach(() => {
  nav.pathname = '/app/finance';
  nav.getNavCounts.mockReset().mockResolvedValue({ ok: true, value: { review: 2, meals: 14 } });
  document.cookie = 'receipts-nav=; max-age=0; path=/';
});
afterEach(cleanup);

describe('a number the receipts page holds', () => {
  it('changes at once, and a late answer of the server leaves it alone', async () => {
    let answer: (v: unknown) => void = () => {};
    nav.getNavCounts.mockReset().mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const store = receiptsStore(14, 0);
    render(
      <AppStoreProvider>
        <AppSidebar session={session} logoutUrl="/logout" initialFolded={false} />
        <OpenReceipts store={store} />
      </AppStoreProvider>,
    );
    await screen.findByText('14');
    act(() => store.rowsRemoved(['r0']));
    await screen.findByText('13');
    await act(async () => answer({ ok: true, value: { review: 14, meals: 2 } }));
    expect(screen.getByText('13')).toBeTruthy();
  });
});

describe('a page with a store', () => {
  it('moves the number with the store, without a report by hand', async () => {
    const store = new MealsStore({ records: [meal({ rowId: 'a', occasion: '' }), meal({ rowId: 'b', occasion: '' })], contacts: [], settings: SMALL_BUSINESS, defaultHost: '', readAt: 0 });
    function Open() {
      const app = useAppStore();
      useEffect(() => app.openMeals(store), [app]);
      return null;
    }
    render(
      <AppStoreProvider>
        <AppSidebar session={session} logoutUrl="/logout" initialFolded={false} />
        <Open />
      </AppStoreProvider>,
    );
    await screen.findByText('2');
    act(() => void store.begin('delete', ['a']));
    await screen.findByText('1');
  });
});

describe('the sidebar', () => {
  it('lists every place, the tools and the upload, on any page', async () => {
    sidebar();
    await screen.findByText('14');
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/app', '/app/overview', '/app/dashboard', '/app/spending', '/app/finance', '/app/meals', '/app/contacts', '/app/rules', '/app/tools', '/logout']);
  });

  it('marks the page you are on, also below it', async () => {
    nav.pathname = '/app/finance/steuer';
    sidebar();
    await screen.findByText('14');
    expect(screen.getByRole('link', { name: /Finanzen/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: /Überblick/ }).getAttribute('aria-current')).toBeNull();
  });

  it('names what the numbers count, and shows none for zero', async () => {
    nav.getNavCounts.mockResolvedValue({ ok: true, value: { review: 0, meals: 3 } });
    sidebar();
    await waitFor(() => expect(screen.getByRole('link', { name: /Bewirtung/ }).textContent).toBe('Bewirtung3 offen'));
    expect(screen.getByRole('link', { name: 'Belege' }).textContent).toBe('Belege');
  });

  it('asks for the numbers on the way out of a page, and keeps the last ones when that fails', async () => {
    const view = sidebar();
    await screen.findByText('14');
    expect(nav.getNavCounts).toHaveBeenCalledTimes(1);

    nav.pathname = '/app/meals';
    nav.getNavCounts.mockResolvedValue({ ok: false });
    view.rerender(
      <AppStoreProvider>
        <AppSidebar session={session} logoutUrl="/logout" initialFolded={false} />
      </AppStoreProvider>,
    );
    await waitFor(() => expect(nav.getNavCounts).toHaveBeenCalledTimes(2));
    expect(screen.getByText('14')).toBeTruthy();
  });

  it('takes the numbers from the dashboard instead of asking again', async () => {
    nav.pathname = '/app/dashboard';
    sidebar(<OpenReceipts store={receiptsStore(5, 1)} />);
    await screen.findByText('5');
    expect(nav.getNavCounts).not.toHaveBeenCalled();
  });

  it('does not show an answer that arrives after the page was left', async () => {
    let answer: (v: unknown) => void = () => {};
    nav.getNavCounts.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const view = sidebar();
    view.unmount();
    await act(async () => answer({ ok: true, value: { review: 9, meals: 9 } }));
    expect(screen.queryByText('9')).toBeNull();
  });

  it('folds, remembers that for the next load, and unfolds', async () => {
    const user = userEvent.setup();
    const { container } = sidebar();
    await screen.findByText('14');
    const aside = container.querySelector('aside');
    expect(aside?.getAttribute('data-folded')).toBe('false');

    await user.click(screen.getByRole('button', { name: 'Seitenleiste einklappen' }));
    expect(aside?.getAttribute('data-folded')).toBe('true');
    expect(document.cookie).toContain('receipts-nav=folded');

    await user.click(screen.getByRole('button', { name: 'Seitenleiste einklappen' }));
    expect(aside?.getAttribute('data-folded')).toBe('false');
    expect(document.cookie).toContain('receipts-nav=open');
  });

  it('starts folded when it was left that way, with every place still named', async () => {
    const { container } = sidebar(undefined, true);
    await screen.findByText('14');
    expect(container.querySelector('aside')?.getAttribute('data-folded')).toBe('true');
    expect(screen.getByRole('link', { name: /Regeln/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Beleg hochladen/ })).toBeTruthy();
  });
});
