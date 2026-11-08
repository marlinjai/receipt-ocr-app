import { describe, expect, it } from 'vitest';
import { sameSubject, subjectKey, whatOf, type ClassificationRule } from '@/lib/classification-rules';
import { buildAssignmentContext } from '../context';
import { evidenceFingerprint, parseModelVerdicts, toModelCounterparty, classificationPrompt, type CounterpartyEvidence } from '@/lib/tax/payments/classify';
import { purposeOf } from '@/lib/spending/rules';
import { classifyPayment } from '@/lib/spending/overview';

/**
 * "Was ist das?" and "Teils, teils" per payment (plan docs/plans/2026-11-07-learned-assignment.md,
 * decision 8), the pure parts. Every name and amount is invented.
 */

const rule = (over: Partial<ClassificationRule>): ClassificationRule => ({ id: 'r', label: '', type: 'freetext', matchValue: 'x', zuordnung: null, ...over });

describe('a statement about one vendor', () => {
  it('is keyed by the vendor as compared, and found for every spelling of it', () => {
    expect(subjectKey('flaschenpost SE')).toBe('flaschenpostse');
    expect(sameSubject('flaschenpostse', 'Flaschenpost')).toBe(true);
    expect(sameSubject('flaschenpostse', 'Rossmann')).toBe(false);
    const rules = [rule({ subject: 'flaschenpostse', label: 'Getränkelieferdienst, Wasser', matchValue: 'flaschenpost SE: Getränkelieferdienst, Wasser' })];
    expect(whatOf(rules, 'Flaschenpost')).toBe('Getränkelieferdienst, Wasser');
    expect(whatOf(rules, 'eBay')).toBeNull();
    // A statement about the person in general is no answer about a vendor.
    expect(whatOf([rule({ matchValue: 'Drogerie ist privat.' })], 'Drogerie')).toBeNull();
  });

  it('reaches the assignment model only for that vendor\'s receipts; one about the person reaches all', () => {
    const statements = [
      { id: 'g', text: 'Drogerie ist privat.', assignment: 'Privat' },
      { id: 'f', text: 'flaschenpost SE: Getränkelieferdienst, Wasser', assignment: null, subject: 'flaschenpostse' },
    ];
    const forFlaschenpost = buildAssignmentContext({ rowId: 'a', vendor: 'Flaschenpost', category: null }, [], statements, []);
    expect(forFlaschenpost.statements.map((s) => s.id)).toEqual(['g', 'f']);
    const forRossmann = buildAssignmentContext({ rowId: 'b', vendor: 'Rossmann', category: null }, [], statements, []);
    expect(forRossmann.statements.map((s) => s.id)).toEqual(['g']);
  });
});

const evidence = (o: Partial<CounterpartyEvidence> = {}): CounterpartyEvidence => ({
  key: 'k',
  label: 'flaschenpost SE',
  paymentCount: 4,
  outCents: 12_000,
  inCents: 0,
  samples: ['Bestellung'],
  linkedPayments: 0,
  matchedPayments: 0,
  receipts: { business: 0, private: 0, mixed: 0, categories: [] },
  invoicePayments: 0,
  incomingPayments: 0,
  filedYears: [],
  openYearPayments: 4,
  filedBusinessReceipts: 0,
  ...o,
});

describe('the counterparty classifier and the person\'s description', () => {
  it('gives the model what the person said, and asks it what it takes the counterparty to be', () => {
    expect(toModelCounterparty(evidence({ statement: 'Getränkelieferdienst, Wasser' }), 'c1').personSays).toBe('Getränkelieferdienst, Wasser');
    expect(toModelCounterparty(evidence(), 'c1').personSays).toBeNull();
    const prompt = classificationPrompt({ webSearch: false });
    expect(prompt).toContain('personSays');
    expect(prompt).toContain('"what"');
    expect(prompt).not.toMatch(/[\u2013\u2014]/);
  });

  it('reads the model\'s "what", and a verdict without one still counts', () => {
    const answer = parseModelVerdicts('{"verdicts":[{"key":"c1","treatment":"private","category":"groceries_drugstore","confidence":"certain","what":"Getränkelieferdienst","reason":"Wasser für den Haushalt."},{"key":"c2","treatment":"mixed","category":null,"confidence":"likely","reason":"Marktplatz."}]}', ['c1', 'c2']);
    expect(answer.get('c1')).toMatchObject({ treatment: 'private', what: 'Getränkelieferdienst' });
    expect(answer.get('c2')).toMatchObject({ treatment: 'mixed', what: null });
  });

  it('a new description makes the counterparty be decided again; without one the fingerprint stays what it was', () => {
    const before = evidenceFingerprint(evidence());
    expect(evidenceFingerprint(evidence({ statement: null }))).toBe(before);
    expect(evidenceFingerprint(evidence({ statement: 'Getränkelieferdienst, Wasser' }))).not.toBe(before);
    expect(evidenceFingerprint(evidence({ statement: 'Getränkelieferdienst, Wasser' }))).not.toBe(evidenceFingerprint(evidence({ statement: 'Marktplatz' })));
  });
});

describe('"Teils, teils": the receipt decides each payment', () => {
  const spend = { kind: 'spend' as const };
  it('a payment follows the receipts linked to it', () => {
    expect(purposeOf({ ...spend, linkCount: 1, linkedPurposes: ['private'] }, 'mixed')).toBe('private');
    expect(purposeOf({ ...spend, linkCount: 2, linkedPurposes: ['private', 'business'] }, 'mixed')).toBe('business');
    expect(purposeOf({ ...spend, linkCount: 1, linkedPurposes: ['open'] }, 'mixed')).toBe('unanswered');
  });
  it('without a receipt it is a question in the overview, and stays private where the caller does not ask (routing)', () => {
    expect(purposeOf({ ...spend, linkCount: 0, unlinkedMixedAsks: true }, 'mixed')).toBe('unanswered');
    expect(purposeOf({ ...spend, linkCount: 0 }, 'mixed')).toBe('private');
    // Without the receipts' purposes a link counts as business, as before.
    expect(purposeOf({ ...spend, linkCount: 1 }, 'mixed')).toBe('business');
  });
  it('only the cents linked to a business receipt are business', () => {
    const base = { id: 'p', accountId: 'a', bookingDay: '2026-03-01', counterparty: 'Amazon', counterpartyKey: 'amazon', reference: '', kind: 'spend' as const };
    const ctx = { treatments: new Map([['amazon', 'mixed' as const]]), answers: new Map() };
    const mixedPay = classifyPayment({ ...base, amountCents: -5_000, linkCount: 2, linkedCents: 5_000, linkedBusinessCents: 2_000, linkedPurposes: ['business', 'private'] }, ctx);
    expect(mixedPay).toMatchObject({ purpose: 'business', businessCents: 2_000 });
    const privatePay = classifyPayment({ ...base, amountCents: -5_000, linkCount: 1, linkedCents: 5_000, linkedBusinessCents: 0, linkedPurposes: ['private'] }, ctx);
    expect(privatePay).toMatchObject({ purpose: 'private', businessCents: 0 });
    const open = classifyPayment({ ...base, amountCents: -5_000, linkCount: 0, linkedCents: 0, linkedBusinessCents: 0, linkedPurposes: [] }, ctx);
    expect(open.purpose).toBe('unanswered');
  });
});
