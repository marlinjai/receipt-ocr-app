import { describe, expect, it } from 'vitest';
import { contactContext, contactCountLabel, visibleContacts, type ListedContact } from '../contact-list';

const contact = (over: Partial<ListedContact> & { id: string; kind: 'person' | 'organization'; name: string }): ListedContact => ({
  companyOrRole: '',
  organizationName: null,
  email: null,
  postalCode: null,
  city: null,
  customerNumber: null,
  archived: false,
  ...over,
});

const ORG = contact({ id: 'o1', kind: 'organization', name: 'Musterwerk', postalCode: '10115', city: 'Beispielstadt', customerNumber: '0007' });
const LINKED = contact({ id: 'p1', kind: 'person', name: 'Änne Beispiel', companyOrRole: 'Einkauf', organizationName: 'Musterwerk' });
const LOOSE = contact({ id: 'p2', kind: 'person', name: 'Bert Muster', companyOrRole: 'Freier Berater', email: 'bert@example.test' });
const GONE = contact({ id: 'p3', kind: 'person', name: 'Carla Archiv', archived: true });
const ALL = [LOOSE, GONE, ORG, LINKED];

const ids = (list: ListedContact[]) => list.map((c) => c.id);
const options = { kind: 'all', query: '', includeArchived: false } as const;

describe('visibleContacts', () => {
  it('mixes persons and organizations under "all", sorted by name, without the archived ones', () => {
    expect(ids(visibleContacts(ALL, options))).toEqual(['p1', 'p2', 'o1']);
  });

  it('includes the archived ones on request', () => {
    expect(ids(visibleContacts(ALL, { ...options, includeArchived: true }))).toEqual(['p1', 'p2', 'p3', 'o1']);
  });

  it('filters by kind', () => {
    expect(ids(visibleContacts(ALL, { ...options, kind: 'person' }))).toEqual(['p1', 'p2']);
    expect(ids(visibleContacts(ALL, { ...options, kind: 'organization' }))).toEqual(['o1']);
  });

  it('finds by name, organization, place, e-mail and customer number, ignoring case and accents', () => {
    expect(ids(visibleContacts(ALL, { ...options, query: 'anne' }))).toEqual(['p1']);
    expect(ids(visibleContacts(ALL, { ...options, query: 'MUSTERWERK' }))).toEqual(['p1', 'o1']);
    expect(ids(visibleContacts(ALL, { ...options, query: 'beispielstadt' }))).toEqual(['o1']);
    expect(ids(visibleContacts(ALL, { ...options, query: 'example.test' }))).toEqual(['p2']);
    expect(ids(visibleContacts(ALL, { ...options, query: '0007' }))).toEqual(['o1']);
  });

  it('needs every search word, and combines the search with the kind filter', () => {
    expect(ids(visibleContacts(ALL, { ...options, query: 'muster berater' }))).toEqual(['p2']);
    expect(ids(visibleContacts(ALL, { ...options, query: 'musterwerk', kind: 'person' }))).toEqual(['p1']);
    expect(visibleContacts(ALL, { ...options, query: 'gibt es nicht' })).toEqual([]);
  });

  it('lists a contact once even when the input names it twice', () => {
    expect(ids(visibleContacts([LINKED, ORG, LINKED], options))).toEqual(['p1', 'o1']);
  });

  it('does not change the list it is given', () => {
    const input = [...ALL];
    visibleContacts(input, options);
    expect(input).toEqual(ALL);
  });
});

describe('contactContext', () => {
  it('names the linked organization of a person, else the free-text company', () => {
    expect(contactContext(LINKED)).toBe('Musterwerk');
    expect(contactContext(LOOSE)).toBe('Freier Berater');
    expect(contactContext(GONE)).toBe('');
  });

  it('names the place of an organization', () => {
    expect(contactContext(ORG)).toBe('10115 Beispielstadt');
    expect(contactContext(contact({ id: 'o2', kind: 'organization', name: 'Ohne Ort' }))).toBe('');
  });
});

describe('contactCountLabel', () => {
  it('uses the singular for one', () => {
    expect(contactCountLabel(1)).toBe('1 Kontakt');
    expect(contactCountLabel(0)).toBe('0 Kontakte');
    expect(contactCountLabel(12)).toBe('12 Kontakte');
  });
});
