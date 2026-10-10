// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Contact } from '@/lib/contacts/store';
import type { MealsPageData } from './actions';

/**
 * The contacts have their own page (/app/contacts). The meal page keeps a plain
 * link to it where the third tab used to be, with the count of active contacts,
 * and shows none of the contact lists itself. The guest picker inside the meal
 * form still creates guests in place, and the count follows them.
 */

vi.mock('./actions', () => ({}));

// The register and the dismissed block are not under test and pull in the receipt viewer.
// It can report unsaved changes in its editor to the page, as the real one does.
vi.mock('./RegisterTab', () => ({
  default: ({ onUnsavedChange }: { onUnsavedChange?: (subject: string | null) => void }) => (
    <div>
      <p>Register</p>
      <button type="button" onClick={() => onUnsavedChange?.('Nr. 1 (Testlokal)')}>Im Eintrag tippen</button>
    </div>
  ),
}));
vi.mock('./DismissedMeals', () => ({ default: () => null }));
// Stands in for the meal form: its guest picker reports a guest created in place.
vi.mock('./QueueTab', () => ({
  default: ({ contacts, onContactCreated }: { contacts: Contact[]; onContactCreated: (c: Contact) => void }) => (
    <div>
      <p data-testid="picker">{contacts.map((c) => c.name).join(', ')}</p>
      <button type="button" onClick={() => onContactCreated({ id: 'p9', name: 'Neuer Gast', companyOrRole: '', note: null, archived: false })}>
        Gast anlegen
      </button>
    </div>
  ),
}));
// A plain anchor that keeps the click handler; a click the page did not stop counts as a navigation.
const followed = vi.fn();
vi.mock('next/link', () => ({
  default: ({ children, href, onClick }: { children: React.ReactNode; href: string; onClick?: React.MouseEventHandler<HTMLAnchorElement> }) => (
    <a
      href={href}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) followed(href);
        e.preventDefault();
      }}
    >
      {children}
    </a>
  ),
}));
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: (...a: unknown[]) => push(...a) }) }));

import MealsClient from './MealsClient';

const guest = (id: string, name: string, archived = false): Contact => ({ id, name, companyOrRole: 'Beispiel', note: null, archived });

function pageData(over: Partial<MealsPageData> = {}): MealsPageData {
  return {
    records: [],
    contacts: [guest('p1', 'Beispiel Person'), guest('p2', 'Archivierte Person', true)],
    organizationCount: 2,
    settings: { smallBusiness: null, hostNameThreshold: 250 } as unknown as MealsPageData['settings'],
    defaultHost: '',
    ...over,
  };
}

afterEach(() => {
  cleanup();
  followed.mockReset();
  push.mockReset();
});

describe('meal page: the contacts live on their own page', () => {
  it('has two tabs and no Kontakte tab', () => {
    render(<MealsClient initial={pageData()} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(['Unvollständig', 'Verzeichnis']);
    expect(screen.queryByRole('tab', { name: /Kontakte/ })).toBeNull();
  });

  it('links to the contacts page with the count of active persons and organizations', () => {
    render(<MealsClient initial={pageData()} />);
    const link = screen.getByRole('link', { name: /Kontakte/ });
    expect(link.getAttribute('href')).toBe('/app/contacts');
    // One active person plus two organizations; the archived person is not counted.
    expect(link.textContent).toBe('Kontakte3');
    // A link next to the tabs, never a tab among them.
    expect(screen.getByRole('tablist').contains(link)).toBe(false);
  });

  it('renders none of the contact lists or their actions', async () => {
    const user = userEvent.setup();
    render(<MealsClient initial={pageData()} />);
    for (const tab of screen.getAllByRole('tab')) {
      await user.click(tab);
      expect(screen.queryByRole('region', { name: 'Verzeichnis' })).toBeNull();
      for (const name of ['Korrigieren', 'Archivieren', 'Exportieren', 'Löschen', 'Angaben bearbeiten', 'Kontakt anlegen', 'Zusammenführen', 'Feld anlegen']) {
        expect(screen.queryByRole('button', { name })).toBeNull();
      }
      expect(screen.queryByText('Eigene Felder')).toBeNull();
    }
  });

  it('a guest created in the meal form reaches the picker and the count without a reload', async () => {
    const user = userEvent.setup();
    render(<MealsClient initial={pageData()} />);
    // Without open meals the page starts on the register; the meal form is on the queue.
    await user.click(screen.getByRole('tab', { name: /Unvollständig/ }));
    expect(screen.getByTestId('picker').textContent).toBe('Beispiel Person, Archivierte Person');

    await user.click(screen.getByRole('button', { name: 'Gast anlegen' }));

    expect(screen.getByTestId('picker').textContent).toContain('Neuer Gast');
    expect(screen.getByRole('link', { name: /Kontakte/ }).textContent).toBe('Kontakte4');
  });
});

describe('meal page: switching tabs with unsaved changes in a form', () => {
  const tab = (name: RegExp) => screen.getByRole('tab', { name });

  it('asks before it leaves the tab: staying keeps the tab and its form, discarding switches', async () => {
    const user = userEvent.setup();
    render(<MealsClient initial={pageData()} />);
    expect(tab(/Verzeichnis/).getAttribute('aria-selected')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Im Eintrag tippen' }));

    await user.click(tab(/Unvollständig/));
    let dialog = screen.getByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' });
    expect(dialog.textContent).toContain('Nr. 1 (Testlokal)');
    await user.click(within(dialog).getByRole('button', { name: 'Weiter bearbeiten' }));
    expect(tab(/Verzeichnis/).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Register')).toBeTruthy();

    await user.click(tab(/Unvollständig/));
    dialog = screen.getByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' });
    await user.click(within(dialog).getByRole('button', { name: 'Änderungen verwerfen' }));
    expect(tab(/Unvollständig/).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText('Register')).toBeNull();
  });

  it('without unsaved changes the tab switches at once', async () => {
    const user = userEvent.setup();
    render(<MealsClient initial={pageData()} />);
    await user.click(tab(/Unvollständig/));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(tab(/Unvollständig/).getAttribute('aria-selected')).toBe('true');
  });
});

describe('meal page: leaving the page with unsaved changes in a form', () => {
  const LINKS: Array<[RegExp, string]> = [
    [/^Dashboard$/, '/app/dashboard'],
    [/^Beleg hochladen$/, '/app'],
    [/^Kontakte/, '/app/contacts'],
  ];

  it('each link of the page asks first: staying goes nowhere, discarding follows the link', async () => {
    const user = userEvent.setup();
    for (const [name, href] of LINKS) {
      render(<MealsClient initial={pageData()} />);
      await user.click(screen.getByRole('button', { name: 'Im Eintrag tippen' }));

      await user.click(screen.getByRole('link', { name }));
      let dialog = screen.getByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' });
      expect(dialog.textContent).toContain('Nr. 1 (Testlokal)');
      await user.click(within(dialog).getByRole('button', { name: 'Weiter bearbeiten' }));
      expect(push).not.toHaveBeenCalled();
      expect(followed).not.toHaveBeenCalled();
      expect(screen.getByText('Register')).toBeTruthy();

      await user.click(screen.getByRole('link', { name }));
      dialog = screen.getByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' });
      await user.click(within(dialog).getByRole('button', { name: 'Änderungen verwerfen' }));
      expect(push).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith(href);
      cleanup();
      push.mockReset();
    }
  });

  it('without unsaved changes the links are plain links', async () => {
    const user = userEvent.setup();
    render(<MealsClient initial={pageData()} />);
    await user.click(screen.getByRole('link', { name: /^Dashboard$/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(followed).toHaveBeenCalledWith('/app/dashboard');
    expect(push).not.toHaveBeenCalled();
  });

  it('a click that opens the link in a new tab takes nothing away and is not stopped', async () => {
    const user = userEvent.setup();
    render(<MealsClient initial={pageData()} />);
    await user.click(screen.getByRole('button', { name: 'Im Eintrag tippen' }));
    await user.keyboard('{Meta>}');
    await user.click(screen.getByRole('link', { name: /^Dashboard$/ }));
    await user.keyboard('{/Meta}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(followed).toHaveBeenCalledWith('/app/dashboard');
  });

  it('reloading or closing the browser tab asks through the browser, only while something is unsaved', async () => {
    const user = userEvent.setup();
    const leave = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const { unmount } = render(<MealsClient initial={pageData()} />);
    expect(leave()).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Im Eintrag tippen' }));
    expect(leave()).toBe(true);

    // Discarding (here: by switching the tab) ends it.
    await user.click(screen.getByRole('tab', { name: /Unvollständig/ }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Änderungen verwerfen' }));
    expect(leave()).toBe(false);

    unmount();
    expect(leave()).toBe(false);
  });
});
