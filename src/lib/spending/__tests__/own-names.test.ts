import { describe, expect, it } from 'vitest';
import { MAX_OWN_NAMES, cleanOwnNames, ownNameKey, treatmentsWithOwnNames } from '../own-names';
import { buildOverview, type OverviewPaymentInput } from '../overview';
import { loopState, type LoopContext } from '../loop';
import type { CounterpartyTreatmentAnswer } from '../rules';
import { vendorKey } from '@/lib/tax/decisions';

/** The own-names rule (plan 2026-10-23, decision 1). Every name is invented. */

describe('ownNameKey', () => {
  it('ignores case, accents, punctuation and the order of the words', () => {
    const key = ownNameKey('Erika Mösl Beispiel');
    expect(ownNameKey('BEISPIEL, ERIKA MÖSL')).toBe(key);
    expect(ownNameKey('Beispiel Erika-Mösl')).toBe(key);
    expect(ownNameKey('erika  moesl   beispiel')).toBe(key);
  });

  it('keeps a legal form as a word: a company in the owner\'s name is not the owner', () => {
    expect(ownNameKey('Erika Beispiel UG')).not.toBe(ownNameKey('Erika Beispiel'));
    expect(ownNameKey('Erika Beispiel GmbH')).toBe('beispiel erika gmbh');
  });

  it('is empty for something that is no name', () => {
    expect(ownNameKey('-')).toBe('');
    expect(ownNameKey('')).toBe('');
  });
});

describe('cleanOwnNames', () => {
  it('trims, drops empty ones and a second spelling of a name already listed', () => {
    expect(cleanOwnNames(['  Erika Beispiel ', '', 'BEISPIEL, ERIKA', 'Erika M. Beispiel'])).toEqual({ ok: true, names: ['Erika Beispiel', 'Erika M. Beispiel'] });
    expect(cleanOwnNames([])).toEqual({ ok: true, names: [] });
  });

  it('refuses what is no list of names, a name with nothing to match on, a very long name and too many names', () => {
    expect(cleanOwnNames('Erika')).toEqual({ ok: false, error: 'invalid_names' });
    expect(cleanOwnNames([42])).toEqual({ ok: false, error: 'invalid_names' });
    expect(cleanOwnNames(['-'])).toEqual({ ok: false, error: 'invalid_names' });
    expect(cleanOwnNames(['x'.repeat(121)])).toEqual({ ok: false, error: 'name_too_long' });
    expect(cleanOwnNames(Array.from({ length: MAX_OWN_NAMES + 1 }, (_, i) => `Name Nummer ${i}`))).toEqual({ ok: false, error: 'too_many_names' });
  });
});

describe('treatmentsWithOwnNames', () => {
  const named = (counterparty: string) => ({ counterparty, counterpartyKey: vendorKey(counterparty) ?? '' });
  const keys = ['Erika Beispiel', 'BEISPIEL, ERIKA', 'Erika Shop', 'REWE'].map(named);

  it('makes every spelling of an own name an own account, never a name that only contains part of it', () => {
    const { treatments, byName } = treatmentsWithOwnNames(new Map(), keys, ['Erika Beispiel']);
    expect([...byName].sort()).toEqual(['beispiel erika', 'erika beispiel']);
    expect(treatments.get('erika beispiel')).toBe('own_account');
    expect(treatments.has('erika shop')).toBe(false);
  });

  it('lets an answer of the payments tab win', () => {
    const answered = new Map<string, CounterpartyTreatmentAnswer>([['erika beispiel', 'private']]);
    const { treatments, byName } = treatmentsWithOwnNames(answered, keys, ['Erika Beispiel']);
    expect(treatments.get('erika beispiel')).toBe('private');
    expect([...byName]).toEqual(['beispiel erika']);
    // The input map is never changed.
    expect(answered.size).toBe(1);
  });

  it('changes nothing without names', () => {
    const answered = new Map<string, CounterpartyTreatmentAnswer>();
    expect(treatmentsWithOwnNames(answered, keys, []).treatments).toBe(answered);
  });

  it('never makes a counterparty key an own account when one of its payments names a company of the owner', () => {
    // "Erika Beispiel UG" has the same counterparty key as "Erika Beispiel": the answer would cover both.
    const { treatments, byName } = treatmentsWithOwnNames(new Map(), [named('Erika Beispiel'), named('Erika Beispiel UG'), named('Erika Beispiel')], ['Erika Beispiel']);
    expect(byName.size).toBe(0);
    expect(treatments.has('erika beispiel')).toBe(false);
  });
});

describe('own names in the overview and the loop', () => {
  let n = 0;
  const pay = (counterparty: string, amountCents: number): OverviewPaymentInput => ({
    id: `p${++n}`,
    accountId: 'a1',
    bookingDay: '2026-10-20',
    amountCents,
    counterparty,
    counterpartyKey: vendorKey(counterparty) ?? '',
    reference: 'Main Account',
    kind: 'spend',
    linkCount: 0,
  });
  const payments = [pay('Erika Beispiel', -100_000), pay('BEISPIEL ERIKA', -20_000), pay('Zyx Handel', -3000)];

  it('forward: own-name payments leave the spending and "unclear", and are named in the own transfers', () => {
    const { treatments, byName } = treatmentsWithOwnNames(new Map(), payments, ['Erika Beispiel']);
    const o = buildOverview(payments, { treatments, byName, answers: new Map() }, 2026, null);
    expect(o.totalCents).toBe(3000);
    expect(o.unclear.map((u) => u.counterparty)).toEqual(['Zyx Handel']);
    expect(o.ownTransfers).toEqual({ cents: 120_000, count: 2, byName: { cents: 120_000, count: 2 } });
  });

  it('backtrack: without the name the payments count and are asked about again', () => {
    const { treatments, byName } = treatmentsWithOwnNames(new Map(), payments, []);
    const o = buildOverview(payments, { treatments, byName, answers: new Map() }, 2026, null);
    expect(o.totalCents).toBe(123_000);
    // Both spellings are back in "unclear", each its own counterparty, next to Zyx Handel.
    expect(o.unclear).toHaveLength(3);
    const ctx: LoopContext = { treatments, categoryAnswers: new Map(), noReceipt: new Map(), receipts: [], vendorAliases: new Map() };
    expect(loopState(payments[0], ctx)).toEqual({ state: 'missing' });
    const named = treatmentsWithOwnNames(new Map(), payments, ['Erika Beispiel']);
    expect(loopState(payments[0], { ...ctx, treatments: named.treatments })).toEqual({ state: 'not_needed', reason: 'own_transfer' });
  });
});
