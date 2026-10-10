/**
 * Pure helpers for the one list of the contacts page (/app/contacts): which
 * contacts are shown for a filter and a search, in which order, and what the
 * second line of a row says. No server imports, so the client component and the
 * tests can both use them.
 */

export type KindFilter = 'all' | 'person' | 'organization';

/** The fields of a contact the list reads. A `DirectoryContact` satisfies it. */
export interface ListedContact {
  id: string;
  kind: 'person' | 'organization';
  name: string;
  companyOrRole: string;
  organizationName: string | null;
  email: string | null;
  postalCode: string | null;
  city: string | null;
  customerNumber: string | null;
  archived: boolean;
}

export const KIND_LABELS: Record<'person' | 'organization', string> = {
  person: 'Person',
  organization: 'Organisation',
};

/** Lower case without accents, so "muller" finds "Müller" and case never matters. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** The place of an organization as one short text, empty when none is recorded. */
export function contactPlace(c: Pick<ListedContact, 'postalCode' | 'city'>): string {
  return [c.postalCode, c.city].filter(Boolean).join(' ');
}

/**
 * The second piece of a row: for a person the organization it belongs to (the
 * linked one, otherwise the free-text company or role), for an organization its place.
 */
export function contactContext(c: ListedContact): string {
  if (c.kind === 'organization') return contactPlace(c);
  return c.organizationName ?? c.companyOrRole;
}

function matches(c: ListedContact, words: string[]): boolean {
  if (words.length === 0) return true;
  const haystack = fold(
    [c.name, c.companyOrRole, c.organizationName, c.email, c.postalCode, c.city, c.customerNumber].filter(Boolean).join(' '),
  );
  return words.every((w) => haystack.includes(w));
}

export interface ContactListOptions {
  kind: KindFilter;
  query: string;
  includeArchived: boolean;
}

/**
 * The contacts the list shows: filtered by kind, archive state and search words
 * (every word must be found), sorted by name. Persons and organizations are mixed
 * under "all". Each contact appears once, whatever the input order.
 */
export function visibleContacts<T extends ListedContact>(contacts: readonly T[], options: ContactListOptions): T[] {
  const words = fold(options.query).split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  return contacts
    .filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      if (!options.includeArchived && c.archived) return false;
      if (options.kind !== 'all' && c.kind !== options.kind) return false;
      return matches(c, words);
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'de') || a.id.localeCompare(b.id));
}

/** "1 Kontakt", "3 Kontakte": the count line under the filters. */
export function contactCountLabel(count: number): string {
  return count === 1 ? '1 Kontakt' : `${count} Kontakte`;
}
