import { describe, expect, it } from 'vitest';
import { categorise } from '@/lib/spending/rules';
import {
  capModelVerdict,
  classificationPrompt,
  cleanReason,
  maskText,
  evidenceFingerprint,
  evidenceVerdict,
  mayLookUp,
  parseModelVerdicts,
  toModelCounterparty,
  type CounterpartyEvidence,
} from '../classify';
import { classifyFailed, classifySummary } from '../classify-summary';
import { appCategories, mergeTreatments, storedVerdict, verdictApplies, type Verdict } from '../verdicts';

/** Every name, text and amount is invented. */
const evidence = (o: Partial<CounterpartyEvidence> = {}): CounterpartyEvidence => ({
  key: 'c1',
  label: 'Werkzeug Abo Beispiel GmbH',
  paymentCount: 3,
  outCents: 6_000,
  inCents: 0,
  samples: ['Abo Oktober', 'Abo November'],
  linkedPayments: 0,
  receipts: { business: 0, private: 0, mixed: 0, categories: [] },
  ...o,
});

const verdict = (o: Partial<Verdict> = {}): Verdict => ({
  counterpartyKey: 'werkzeug abo beispiel',
  label: 'Werkzeug Abo Beispiel',
  treatment: 'business',
  category: 'software_ai_hosting',
  confidence: 'certain',
  reason: 'Software-Abo für die Arbeit',
  source: 'model',
  ...o,
});

describe('who decides a counterparty', () => {
  const payments = [
    { counterpartyKey: 'werkzeug abo beispiel', counterparty: 'Werkzeug Abo Beispiel', amountCents: -2_000 },
    { counterpartyKey: 'max beispiel', counterparty: 'Max Beispiel', amountCents: -30_000 },
    { counterpartyKey: 'laden beispiel', counterparty: 'Laden Beispiel', amountCents: -4_500 },
  ];

  it('a person first, then the own names, then the app when it is certain', () => {
    const person = new Map([['laden beispiel', 'mixed' as const]]);
    const verdicts = [verdict(), verdict({ counterpartyKey: 'laden beispiel', treatment: 'private' }), verdict({ counterpartyKey: 'max beispiel', treatment: 'private' })];
    const { treatments, sources } = mergeTreatments(person, payments, ['Max Beispiel'], verdicts);
    expect(Object.fromEntries(treatments)).toEqual({ 'laden beispiel': 'mixed', 'max beispiel': 'own_account', 'werkzeug abo beispiel': 'business' });
    expect(Object.fromEntries(sources)).toEqual({ 'laden beispiel': 'person', 'max beispiel': 'own_name', 'werkzeug abo beispiel': 'app' });
  });

  it("a person's private answer for an own name stays private under Finanzen", () => {
    const { treatments, sources } = mergeTreatments(new Map([['max beispiel', 'private' as const]]), payments, ['Max Beispiel'], []);
    expect(treatments.get('max beispiel')).toBe('private');
    expect(sources.get('max beispiel')).toBe('person');
  });

  it('a likely or unsure verdict only proposes, and a verdict without a treatment decides nothing', () => {
    const { treatments } = mergeTreatments(new Map(), payments, [], [verdict({ confidence: 'likely' }), verdict({ counterpartyKey: 'laden beispiel', confidence: 'unsure' }), verdict({ counterpartyKey: 'max beispiel', treatment: null })]);
    expect(treatments.size).toBe(0);
    expect(verdictApplies({ confidence: 'certain' })).toBe(true);
    expect(verdictApplies({ confidence: 'likely' })).toBe(false);
  });

  it('money coming in after a certain verdict keeps the model from deciding anything but business there', () => {
    const withIncome = [...payments, { counterpartyKey: 'laden beispiel', counterparty: 'Laden Beispiel', amountCents: 9_000 }];
    const verdicts = [verdict({ counterpartyKey: 'laden beispiel', treatment: 'private' }), verdict({ counterpartyKey: 'max beispiel', treatment: 'own_account' })];
    expect(mergeTreatments(new Map(), withIncome, [], verdicts).treatments.size).toBe(0);
    // The company's own receipts may still decide it, and business stays business.
    expect(mergeTreatments(new Map(), withIncome, [], [verdict({ counterpartyKey: 'laden beispiel', treatment: 'private', source: 'evidence' })]).treatments.get('laden beispiel')).toBe('private');
    expect(mergeTreatments(new Map(), withIncome, [], [verdict({ counterpartyKey: 'laden beispiel', treatment: 'business' })]).treatments.get('laden beispiel')).toBe('business');
  });

  it('only certain categories reach the spending side, and a word rule still comes before them', () => {
    expect(Object.fromEntries(appCategories([verdict(), verdict({ counterpartyKey: 'laden beispiel', category: 'groceries_drugstore', confidence: 'likely' })]))).toEqual({ 'werkzeug abo beispiel': 'software_ai_hosting' });
    const payment = { kind: 'spend' as const, counterpartyKey: 'tankstelle beispiel', reference: '' };
    expect(categorise(payment, { suggested: 'groceries_drugstore' })).toEqual({ category: 'transport', basis: 'keyword' });
    expect(categorise({ ...payment, counterpartyKey: 'nordwind handel' }, { suggested: 'shopping_household' })).toEqual({ category: 'shopping_household', basis: 'app' });
    expect(categorise({ ...payment, counterpartyKey: 'nordwind handel' }, { answer: 'leisure_sport', suggested: 'shopping_household' })).toEqual({ category: 'leisure_sport', basis: 'answer' });
  });

  it('a stored row with values no longer known is read as less, never miscounted', () => {
    const row = { counterpartyKey: 'k', label: 'K', treatment: 'business', category: 'software_ai_hosting', confidence: 'certain', reason: 'r', source: 'model' };
    expect(storedVerdict(row)).toMatchObject({ treatment: 'business', category: 'software_ai_hosting', confidence: 'certain', source: 'model' });
    expect(storedVerdict({ ...row, treatment: 'gift', category: 'unclear' })).toMatchObject({ treatment: null, category: null });
    expect(storedVerdict({ ...row, confidence: 'sure' })).toBeNull();
    expect(storedVerdict({ ...row, source: 'evidence' })?.source).toBe('evidence');
  });
});

describe("the company's own data", () => {
  it('receipts all business or all private decide; mixed or both kinds say nothing certain', () => {
    expect(evidenceVerdict(evidence({ linkedPayments: 3, receipts: { business: 3, private: 0, mixed: 0, categories: [] } }))).toMatchObject({ treatment: 'business', confidence: 'certain', reason: 'Alle 3 zugeordneten Belege sind betrieblich.' });
    expect(evidenceVerdict(evidence({ linkedPayments: 2, receipts: { business: 0, private: 1, mixed: 0, categories: [] } }))).toMatchObject({ treatment: 'private', confidence: 'certain', reason: 'Der zugeordnete Beleg ist privat.' });
    expect(evidenceVerdict(evidence({ receipts: { business: 2, private: 1, mixed: 0, categories: [] } }))).toBeNull();
    expect(evidenceVerdict(evidence({ receipts: { business: 2, private: 0, mixed: 1, categories: [] } }))).toBeNull();
    expect(evidenceVerdict(evidence())).toBeNull();
  });

  it('one linked receipt among many unlinked payments is a hint, not a verdict for all of them', () => {
    const marketplace = evidence({ paymentCount: 40, linkedPayments: 1, receipts: { business: 1, private: 0, mixed: 0, categories: [] } });
    expect(evidenceVerdict(marketplace)).toMatchObject({ treatment: 'business', confidence: 'likely' });
    expect(evidenceVerdict({ ...marketplace, linkedPayments: 20 })).toMatchObject({ confidence: 'certain' });
  });

  it('the fingerprint follows the linked receipts, not the number of payments', () => {
    const base = evidenceFingerprint(evidence());
    expect(evidenceFingerprint(evidence({ paymentCount: 9, outCents: 99_000, samples: ['anders'] }))).toBe(base);
    expect(evidenceFingerprint(evidence({ receipts: { business: 1, private: 0, mixed: 0, categories: [] } }))).not.toBe(base);
    expect(evidenceFingerprint(evidence({ receipts: { business: 0, private: 0, mixed: 0, categories: ['Software'] } }))).not.toBe(base);
    expect(evidenceFingerprint(evidence({ linkedPayments: 2 }))).not.toBe(base);
    // The first money coming in is new evidence too.
    expect(evidenceFingerprint(evidence({ inCents: 1 }))).not.toBe(base);
  });
});

describe('what the model sees', () => {
  it('a business name may be looked up, a name that may be a person never', () => {
    expect(mayLookUp('Werkzeug Abo Beispiel GmbH')).toBe(true);
    expect(mayLookUp('Nordwind Handel Ltd.')).toBe(true);
    expect(mayLookUp('beispiel-shop.de')).toBe(true);
    expect(mayLookUp('Laden 24')).toBe(true);
    expect(mayLookUp('Max Beispiel')).toBe(false);
    expect(mayLookUp('Agnes Beispiel')).toBe(false);
    // Short words that are also parts of names are no legal form, and one digit makes no business.
    expect(mayLookUp('Jonas Ab')).toBe(false);
    expect(mayLookUp('Max Beispiel 2')).toBe(false);
  });

  it('gets the name, counts, sums, a few texts and the linked receipts, and nothing else', () => {
    const asked = toModelCounterparty(evidence({ samples: ['a', 'b', 'c', 'd'], receipts: { business: 1, private: 0, mixed: 0, categories: ['Software', 'Software'] } }), 'c1');
    // A name that may be looked up goes out without its payment texts: they can name other people.
    expect(asked).toEqual({
      key: 'c1',
      name: 'Werkzeug Abo Beispiel GmbH',
      payments: 3,
      paidEuro: '60.00',
      receivedEuro: '0.00',
      texts: [],
      linkedReceipts: '1 business, 0 private, 0 mixed; categories: Software',
      mayLookUp: true,
    });
    // Any other name goes to a call without search, with up to three texts, numbers and addresses masked.
    const person = toModelCounterparty(evidence({ label: 'Max Beispiel', samples: ['Miete DE89 3704 0044 0532 0130 00', 'x@beispiel.de schickt', 'c', 'd'] }), 'c2');
    expect(person).toMatchObject({ mayLookUp: false, texts: ['Miete [Konto]', '[E-Mail] schickt', 'c'] });
    // The request key is opaque and the name is masked: nothing derived from an account number or address reaches the model.
    const leaky = toModelCounterparty(evidence({ key: 'max@beispiel.de de89370400440532013000', label: 'max@beispiel.de DE89 3704 0044 0532 0130 00' }), 'c3');
    expect(leaky.key).toBe('c3');
    expect(leaky.name).toBe('[E-Mail] [Konto]');
    expect(mayLookUp('max@beispiel.de')).toBe(false);
    expect(classificationPrompt({ webSearch: true })).toMatch(/Never search for a counterparty marked mayLookUp false/);
    expect(classificationPrompt({ webSearch: false })).not.toMatch(/You have web search/);
  });
});

describe("what of the model's verdict may count by itself", () => {
  const certain = (treatment: 'business' | 'private' | 'own_account' | 'mixed') => ({ treatment, category: null, confidence: 'certain' as const, reason: 'r' });
  it('never an own account, and nothing but business for someone who paid money in: those stay proposals', () => {
    expect(capModelVerdict(certain('own_account'), { inCents: 0 }).confidence).toBe('likely');
    expect(capModelVerdict(certain('private'), { inCents: 500 }).confidence).toBe('likely');
    expect(capModelVerdict(certain('mixed'), { inCents: 500 }).confidence).toBe('likely');
    expect(capModelVerdict(certain('business'), { inCents: 500 }).confidence).toBe('certain');
    expect(capModelVerdict(certain('private'), { inCents: 0 }).confidence).toBe('certain');
    expect(capModelVerdict({ ...certain('own_account'), confidence: 'unsure' }, { inCents: 0 }).confidence).toBe('unsure');
  });
});

describe('what leaves the house', () => {
  it('payment texts lose account, card and other long numbers', () => {
    expect(maskText('SEPA Lastschrift DE89 3704 0044 0532 0130 00 Mandat 4711-0815-2233 Abo')).toBe('SEPA Lastschrift [Konto] Mandat [Nummer] Abo');
    expect(maskText('Karte 4111 1111 1111 1111 Einkauf')).toBe('Karte [Nummer] Einkauf');
    expect(maskText('Abo Oktober 2026')).toBe('Abo Oktober 2026');
    expect(maskText('x'.repeat(300))).toHaveLength(140);
  });
});

describe("reading the model's answer", () => {
  const asked = ['werkzeug abo beispiel', 'laden beispiel', 'max beispiel'];

  it('takes only known values for the keys asked, each once', () => {
    const text = `Hier: {"verdicts":[
      {"key":"werkzeug abo beispiel","treatment":"business","category":"software_ai_hosting","confidence":"certain","reason":"Software-Abo"},
      {"key":"werkzeug abo beispiel","treatment":"private","category":"leisure_sport","confidence":"certain","reason":"zweimal"},
      {"key":"laden beispiel","treatment":"private","category":"unclear","confidence":"likely","reason":"Laden"},
      {"key":"max beispiel","treatment":"gift","category":"transfers","confidence":"certain","reason":"x"},
      {"key":"fremd","treatment":"business","category":"cash","confidence":"certain","reason":"nicht gefragt"}
    ]}`;
    const verdicts = parseModelVerdicts(text, asked);
    expect([...verdicts.keys()]).toEqual(['werkzeug abo beispiel', 'laden beispiel']);
    expect(verdicts.get('werkzeug abo beispiel')).toEqual({ treatment: 'business', category: 'software_ai_hosting', confidence: 'certain', reason: 'Software-Abo' });
    expect(verdicts.get('laden beispiel')).toMatchObject({ category: null, confidence: 'likely' });
  });

  it('a verdict without a reason is at most unsure; garbage reads as nothing', () => {
    const verdicts = parseModelVerdicts('{"verdicts":[{"key":"laden beispiel","treatment":"private","category":"groceries_drugstore","confidence":"certain","reason":"  "}]}', asked);
    expect(verdicts.get('laden beispiel')).toMatchObject({ confidence: 'unsure', reason: 'Ohne Begründung geantwortet.' });
    expect(parseModelVerdicts('keine Ahnung', asked).size).toBe(0);
    expect(parseModelVerdicts('{"verdicts": "nein"}', asked).size).toBe(0);
    expect(parseModelVerdicts('{"verdicts": [', asked).size).toBe(0);
  });

  it('a reason is one line, without long dashes, at most 200 characters', () => {
    expect(cleanReason('Supermarkt \u2014 Einkauf\n für zu Hause')).toBe('Supermarkt, Einkauf für zu Hause');
    expect(cleanReason('Laden \u2013 Haushalt')).toBe('Laden, Haushalt');
    expect(cleanReason('x'.repeat(300))).toHaveLength(200);
    expect(cleanReason(42)).toBe('');
  });
});

describe('what a run says', () => {
  const run = { pending: 0, byEvidence: 0, byModel: 0, applied: 0, unavailable: false, failedBatches: 0, unanswered: 0, removed: 0, stoppedEarly: false };
  it('nothing to decide says nothing; a run names what it decided and what follows', () => {
    expect(classifySummary(run)).toBe('');
    expect(classifySummary({ ...run, pending: 5, byEvidence: 1, byModel: 4, applied: 5 })).toBe('Die App hat 5 Gegenseiten eingeordnet, alle sicher.');
    expect(classifySummary({ ...run, pending: 50, byModel: 40, applied: 30 })).toBe('Die App hat 40 Gegenseiten eingeordnet, davon 30 sicher; die übrigen sind Vorschläge. 10 weitere folgen beim nächsten Prüfen.');
  });
  it('a run that decided nothing because the model failed is a failure, not a notice', () => {
    expect(classifySummary({ ...run, pending: 3, failedBatches: 1, unanswered: 0, removed: 0, stoppedEarly: false })).toBe('Die Gegenseiten konnten gerade nicht eingeordnet werden; beim nächsten Prüfen wird es wieder versucht.');
    expect(classifyFailed({ ...run, pending: 3, failedBatches: 1, unanswered: 0, removed: 0, stoppedEarly: false })).toBe(true);
    expect(classifyFailed({ ...run, pending: 3, byEvidence: 1, failedBatches: 1, unanswered: 0, removed: 0, stoppedEarly: false })).toBe(false);
    expect(classifyFailed(null)).toBe(true);
    expect(classifyFailed(run)).toBe(false);
  });
  it('says when no model is configured or a batch failed, and when the whole step failed', () => {
    expect(classifySummary({ ...run, pending: 4, byEvidence: 1, applied: 1, unavailable: true })).toBe('Die App hat 1 Gegenseite eingeordnet, alle sicher. Ohne Sprachmodell auf dem Server ordnet die App nur ein, was zugeordnete Belege eindeutig sagen.');
    expect(classifySummary({ ...run, pending: 40, byModel: 20, applied: 20, failedBatches: 1, unanswered: 0, removed: 0, stoppedEarly: false })).toMatch(/Ein Teil konnte gerade nicht eingeordnet werden/);
    expect(classifySummary(null)).toMatch(/konnten nicht eingeordnet werden/);
  });
});
