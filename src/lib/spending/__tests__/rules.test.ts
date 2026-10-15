import { describe, expect, it } from 'vitest';
import { SPENDING_CATEGORIES } from '../categories';
import { KEYWORD_RULES, categorise, keywordCategory, purposeOf, spendingCents } from '../rules';

/** Every name here is a brand or an invented word, never a person. */
const spend = (counterpartyKey: string, reference = '') => ({ kind: 'spend' as const, counterpartyKey, reference });

describe('categorise', () => {
  it.each([
    ['github', '', 'software_ai_hosting'],
    ['deutsche bahn', '', 'transport'],
    ['rewe markt', '', 'groceries_drugstore'],
    ['lieferando', '', 'eating_out_coffee'],
    ['ikea', '', 'shopping_household'],
    ['stadtwerke beispielstadt', '', 'housing_utilities'],
    ['beispielbank', 'Kreditrate 10/2026', 'loans_leasing_credit'],
    ['netflix', '', 'leisure_sport'],
    ['beispielbank', 'Entgelt Kontoführung', 'fees_interest'],
    ['', 'Geldautomat Hauptbahnhof', 'cash'],
  ])('finds %s / %s as %s', (counterpartyKey, reference, category) => {
    expect(categorise(spend(counterpartyKey, reference))).toEqual({ category, basis: 'keyword' });
  });

  it('leaves what nothing recognizes unclear', () => {
    expect(categorise(spend('zyx handel', 'Rechnung 4711'))).toEqual({ category: 'unclear', basis: 'none' });
  });

  it('matches whole words only', () => {
    expect(keywordCategory('reweland', '')).toBeNull();
    expect(keywordCategory('', 'Kreditkartenabrechnung')).toBeNull();
  });

  it('tries cash, loans and fees before brands, and a longer brand before its prefix', () => {
    expect(categorise(spend('rewe', 'Bargeld an der Kasse')).category).toBe('cash');
    expect(categorise(spend('amazon web services')).category).toBe('software_ai_hosting');
    expect(categorise(spend('uber eats')).category).toBe('eating_out_coffee');
  });

  it('puts own transfers under transfers, whatever the answer or the words say', () => {
    expect(categorise({ kind: 'own_transfer', counterpartyKey: 'rewe', reference: '' }, { answer: 'leisure_sport' })).toEqual({ category: 'transfers', basis: 'own_account' });
    expect(categorise(spend('tagesgeld'), { treatment: 'own_account', answer: 'cash' })).toEqual({ category: 'transfers', basis: 'own_account' });
  });

  it('lets a person\'s answer win over the kind and over the words', () => {
    expect(categorise(spend('rewe'), { answer: 'eating_out_coffee' })).toEqual({ category: 'eating_out_coffee', basis: 'answer' });
    expect(categorise({ kind: 'fee', counterpartyKey: 'x', reference: '' }, { answer: 'loans_leasing_credit' }).category).toBe('loans_leasing_credit');
  });

  it('takes a fee from its kind before the words', () => {
    expect(categorise({ kind: 'fee', counterpartyKey: 'netflix', reference: '' })).toEqual({ category: 'fees_interest', basis: 'kind' });
  });

  it('only uses known categories in its rules', () => {
    for (const rule of KEYWORD_RULES) expect(SPENDING_CATEGORIES).toContain(rule.category);
  });
});

describe('purposeOf', () => {
  it('is private when the payment or its counterparty was said to be private', () => {
    expect(purposeOf({ kind: 'private' }, undefined)).toBe('private');
    expect(purposeOf({ kind: 'spend' }, 'private')).toBe('private');
  });
  it('is business only on a business answer, and unanswered otherwise', () => {
    expect(purposeOf({ kind: 'spend' }, 'business')).toBe('business');
    expect(purposeOf({ kind: 'spend' }, undefined)).toBe('unanswered');
  });
});

describe('spendingCents', () => {
  it('counts money out positive, money back negative, and income or own transfers not at all', () => {
    expect(spendingCents({ kind: 'spend', amountCents: -1250 })).toBe(1250);
    expect(spendingCents({ kind: 'refund', amountCents: 500 })).toBe(-500);
    expect(spendingCents({ kind: 'income', amountCents: 10_000 })).toBeNull();
    expect(spendingCents({ kind: 'own_transfer', amountCents: -10_000 })).toBeNull();
  });
});
