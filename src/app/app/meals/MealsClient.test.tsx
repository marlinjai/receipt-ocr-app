// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
vi.mock('./RegisterTab', () => ({ default: () => <p>Register</p> }));
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
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

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

afterEach(cleanup);

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
