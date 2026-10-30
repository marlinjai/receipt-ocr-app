// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AppSidebar from '../AppSidebar';
import { NavCountsProvider, useReportNavCounts } from '../nav-counts';

const nav = vi.hoisted(() => ({ pathname: '/app/finance', getNavCounts: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));
vi.mock('@/app/app/nav-actions', () => ({ getNavCounts: nav.getNavCounts }));
vi.mock('@/components/WorkspaceSwitcher', () => ({ default: () => <label>Firma<select aria-label="Active company workspace" /></label> }));
vi.mock('@/app/app/spending/PushSession', () => ({ SignOutLink: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

const session = { email: 'owner@example.test' } as never;

function Reporter({ review, meals }: { review: number; meals: number }) {
  useReportNavCounts({ review, meals });
  return null;
}

function sidebar(extra?: React.ReactNode, initialFolded = false) {
  return render(
    <NavCountsProvider>
      <AppSidebar session={session} logoutUrl="/logout" initialFolded={initialFolded} />
      {extra}
    </NavCountsProvider>,
  );
}

beforeEach(() => {
  nav.pathname = '/app/finance';
  nav.getNavCounts.mockReset().mockResolvedValue({ ok: true, value: { review: 2, meals: 14 } });
  document.cookie = 'receipts-nav=; max-age=0; path=/';
});
afterEach(cleanup);

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
      <NavCountsProvider>
        <AppSidebar session={session} logoutUrl="/logout" initialFolded={false} />
      </NavCountsProvider>,
    );
    await waitFor(() => expect(nav.getNavCounts).toHaveBeenCalledTimes(2));
    expect(screen.getByText('14')).toBeTruthy();
  });

  it('takes the numbers from the dashboard instead of asking again', async () => {
    nav.pathname = '/app/dashboard';
    sidebar(<Reporter review={5} meals={1} />);
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
