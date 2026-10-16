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

  it('never takes a surname or an ordinary invoice word in the text for a brand', () => {
    expect(categorise(spend('', 'Danke Mueller fuer das Geschenk')).category).toBe('unclear');
    expect(categorise(spend('', 'Betrag netto 100')).category).toBe('unclear');
    expect(categorise(spend('', 'Rechnung 1/1')).category).toBe('unclear');
    expect(categorise(spend('', 'Otto Beispiel Geburtstag')).category).toBe('unclear');
    // A person with a brand's name as counterparty is no brand.
    expect(categorise(spend('otto beispiel')).category).toBe('unclear');
    expect(categorise(spend('penny beispiel')).category).toBe('unclear');
    expect(categorise(spend('miles beispiel')).category).toBe('unclear');
    expect(categorise(spend('otto')).category).toBe('shopping_household');
    expect(categorise(spend('otto versand')).category).toBe('shopping_household');
    // In the counterparty's own name they do count.
    expect(categorise(spend('netto marken discount')).category).toBe('groceries_drugstore');
  });

  it('lets the counterparty\'s name win over a brand word in the text', () => {
    expect(categorise(spend('vodafone', 'Rechnung Amazon Prime Kanal')).category).toBe('housing_utilities');
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

  it('still lets a fee word in the text decide before a brand name: fees need no receipt', () => {
    expect(categorise(spend('vodafone', 'inkl. Gebühr')).category).toBe('fees_interest');
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
  it('of a counterparty answered mixed, what is linked to a receipt is business and the rest private', () => {
    expect(purposeOf({ kind: 'spend', linkCount: 1 }, 'mixed')).toBe('business');
    expect(purposeOf({ kind: 'spend', linkCount: 0 }, 'mixed')).toBe('private');
    expect(purposeOf({ kind: 'spend' }, 'mixed')).toBe('private');
  });
});

describe('spendingCents', () => {
  it('counts money out positive, money back negative, and income or own transfers not at all', () => {
    expect(spendingCents({ kind: 'spend', amountCents: -1250 })).toBe(1250);
    expect(spendingCents({ kind: 'refund', amountCents: 500 })).toBe(-500);
    expect(spendingCents({ kind: 'income', amountCents: 10_000 })).toBeNull();
    expect(spendingCents({ kind: 'own_transfer', amountCents: -10_000 })).toBeNull();
  });
  it('never counts money coming in that was marked private (a friend paying back) as negative spending', () => {
    expect(spendingCents({ kind: 'private', amountCents: 5000 })).toBeNull();
    expect(spendingCents({ kind: 'private', amountCents: -5000 })).toBe(5000);
    expect(spendingCents({ kind: 'spend', amountCents: 5000 })).toBeNull();
  });
  it('lets a fee given back lower the fees', () => {
    expect(spendingCents({ kind: 'fee', amountCents: 300 })).toBe(-300);
    expect(spendingCents({ kind: 'fee', amountCents: -300 })).toBe(300);
  });
});
