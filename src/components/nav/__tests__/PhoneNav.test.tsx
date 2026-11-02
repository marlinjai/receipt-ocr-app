// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PhoneNav from '../PhoneNav';
import { AppStoreProvider } from '@/stores/provider';

const nav = vi.hoisted(() => ({ pathname: '/app/finance', getNavCounts: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));
vi.mock('@/app/app/nav-actions', () => ({ getNavCounts: nav.getNavCounts }));
vi.mock('@/components/WorkspaceSwitcher', () => ({ default: () => <label>Firma<select aria-label="Active company workspace" /></label> }));
vi.mock('@/app/app/spending/PushSession', () => ({ SignOutLink: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

const session = { email: 'owner@example.test' } as never;
const phoneNav = () =>
  render(
    <AppStoreProvider company="Beispiel GmbH">
      <PhoneNav session={session} logoutUrl="/logout" />
    </AppStoreProvider>,
  );
const bar = () => within(screen.getByRole('navigation', { name: 'Hauptbereiche' }));

beforeEach(() => {
  nav.pathname = '/app/finance';
  nav.getNavCounts.mockReset().mockResolvedValue({ ok: true, value: { review: 2, meals: 14 } });
});
afterEach(cleanup);

describe('the phone navigation', () => {
  it('holds the main places and the upload, always', () => {
    phoneNav();
    expect(bar().getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/app/dashboard', '/app/spending', '/app', '/app/finance']);
    expect(bar().getByRole('link', { name: 'Finanzen' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows what is open, also what waits behind "Mehr"', async () => {
    phoneNav();
    expect((await bar().findByRole('link', { name: 'Belege, 2 zu prüfen' })).getAttribute('href')).toBe('/app/dashboard');
    expect(bar().getByRole('button', { name: 'Mehr, 14 offen' })).toBeTruthy();
  });

  it('opens every place of the sidebar, the company, the settings and signing out, and closes on a tap', async () => {
    const user = userEvent.setup();
    phoneNav();
    await user.click(bar().getByRole('button', { name: /Mehr/ }));
    const sheet = within(screen.getByRole('dialog', { name: 'Alle Bereiche' }));
    expect(sheet.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/app/overview',
      '/app/dashboard',
      '/app/spending',
      '/app/finance',
      '/app/meals',
      '/app/contacts',
      '/app/rules',
      '/app/tools',
      '/app/spending?ansicht=belege&einstellung=benachrichtigung',
      '/logout',
    ]);
    expect(sheet.getByRole('combobox', { name: 'Active company workspace' })).toBeTruthy();
    await user.click(sheet.getByRole('link', { name: /Benachrichtigungen/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lights "Mehr" on a place that is not on the bar, and nothing on the upload page but the upload', () => {
    nav.pathname = '/app/contacts';
    const { unmount } = phoneNav();
    expect(bar().getByRole('button', { name: /Mehr/ }).getAttribute('data-current')).toBe('true');
    unmount();
    nav.pathname = '/app';
    phoneNav();
    expect(bar().getByRole('button', { name: /Mehr/ }).getAttribute('data-current')).toBe('false');
    expect(bar().getByRole('link', { name: 'Hochladen' }).getAttribute('aria-current')).toBe('page');
  });
});
