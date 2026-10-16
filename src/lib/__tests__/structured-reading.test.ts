import { describe, expect, it } from 'vitest';
import { readStructuredInvoice, structuredReceiptFields } from '@/lib/einvoice';
import { CII_INVOICE, UBL_CREDIT_NOTE, UBL_INVOICE } from '@/lib/einvoice/__tests__/samples';
import { extractReceiptFields } from '../extract-receipt-fields';
import { settleReading, type ModelReading } from '../receipt-reading';
import { withStructuredInvoice } from '../structured-reading';
import { EMPTY_MEAL_CLASSIFICATION } from '../meals/classify';

const answer = (extra: Partial<ModelReading> = {}): ModelReading => ({
  item: 'Lizenz',
  category: 'Software & Lizenzen',
  konto: '4806',
  zuordnung: null,
  taxRate: null,
  vendor: 'Muster Software',
  gross: null,
  net: null,
  date: null,
  currency: null,
  noTotal: false,
  sawPage: true,
  meal: { ...EMPTY_MEAL_CLASSIFICATION },
  ...extra,
});

const fieldsOf = async (xml: string) => {
  const reading = await readStructuredInvoice(new TextEncoder().encode(xml));
  if (!reading) throw new Error('sample not read');
  return structuredReceiptFields(reading.invoice);
};
const settle = (text: string, ai: ModelReading | null) => settleReading(text, extractReceiptFields({ fullText: text, blocks: [], confidence: 0.9 }), ai);

describe('withStructuredInvoice: the structured data is the invoice', () => {
  it('its date, total, net, tax groups and currency stand over a page reading that differs, and the doubts about them go', async () => {
    const fields = await fieldsOf(UBL_INVOICE);
    // A page reading that got the total wrong and doubted it.
    const page = settle('Muster Software\nRechnung\nDatum 15.09.2026\nGesamt 150,00 €', answer({ gross: 150, date: '2026-09-15T00:00:00.000Z' }));
    const settled = withStructuredInvoice(page, fields);
    expect(settled).toMatchObject({ date: '2026-09-14T00:00:00.000Z', gross: 172.5, net: 150, currency: 'EUR', taxRate: 19 });
    expect(settled.amounts.taxGroups.map((g) => g.rate)).toEqual([19, 7]);
    expect(settled.flags).not.toContain('total_unconfirmed');
    expect(settled.flags).not.toContain('total_conflict');
    expect(settled.flags).not.toContain('date_conflict');
  });

  it('the name a customer uses stays; the legal name of the XML fills a gap only', async () => {
    const fields = await fieldsOf(UBL_INVOICE);
    const page = 'Muster Software\nRechnung\nDatum 14.09.2026\nGesamt 172,50 €';
    expect(withStructuredInvoice(settle(page, answer({ vendor: 'Muster Software' })), fields).vendor).toBe('Muster Software');
    expect(withStructuredInvoice({ ...settle(page, answer()), vendor: null }, fields).vendor).toBe(fields.vendor);
  });

  it('read from the XML\'s own text, the heading is no vendor: the model\'s name, else the seller', async () => {
    const fields = await fieldsOf(UBL_INVOICE);
    const withModel = settle(fields.text, answer({ vendor: 'Muster Software' }));
    expect(withStructuredInvoice(withModel, fields, { textFromStructure: true, modelVendor: 'Muster Software' }).vendor).toBe('Muster Software');
    // No model answer: the text reader alone takes the heading line.
    const alone = settle(fields.text, null);
    expect(alone.vendor).not.toBe(fields.vendor);
    expect(withStructuredInvoice(alone, fields, { textFromStructure: true, modelVendor: null }).vendor).toBe(fields.vendor);
  });

  it('amounts in a currency the app has no option for are not stored as euros: they stay empty and a person looks', async () => {
    const fields = { ...(await fieldsOf(UBL_INVOICE)), currency: 'CHF' };
    const settled = withStructuredInvoice(settle(fields.text, answer()), fields);
    expect(settled).toMatchObject({ gross: null, net: null });
    expect(settled.amounts.taxGroups).toEqual([]);
    expect(settled.flags).toContain('currency_unknown');
    expect(settled.flags).not.toContain('credit_note');
  });

  it('the model\'s name counts however it is spaced or punctuated', async () => {
    const fields = await fieldsOf(UBL_INVOICE);
    const withModel = settle(fields.text, answer({ vendor: 'Muster Software' }));
    expect(withStructuredInvoice(withModel, fields, { textFromStructure: true, modelVendor: '  Muster  Software. ' }).vendor).toBe(withModel.vendor);
  });

  it('an XRechnung without a page: its figures as text are read, and the reading says nothing about a page', async () => {
    const fields = await fieldsOf(CII_INVOICE);
    const settled = withStructuredInvoice(settle(fields.text, answer({ sawPage: false })), fields);
    expect(settled.flags).not.toContain('page_not_read');
    expect(settled.gross).toBe(fields.gross);
  });

  it('a credit note is a receipt with a negative amount on its own day; figures that do not add up are put up for a look', async () => {
    const credit = await fieldsOf(UBL_CREDIT_NOTE);
    const settled = withStructuredInvoice(settle(credit.text, answer()), credit);
    expect(settled.gross).toBe(-Math.abs(credit.gross!));
    expect(settled.net).toBeLessThan(0);
    expect(Math.abs(settled.net!)).toBeLessThanOrEqual(Math.abs(settled.gross!));
    expect(settled.date).toBe(credit.date);
    // A tax line is never negative: the rate is kept, the lines are not.
    expect(settled.amounts.taxGroups).toEqual([]);
    expect(settled.taxRate).toBe(credit.taxRate);
    const fields = await fieldsOf(UBL_INVOICE);
    const broken = { ...fields, problems: ['the tax groups do not add up to the total'] };
    expect(withStructuredInvoice(settle(fields.text, answer()), broken).flags).toContain('einvoice_problem');
  });

  it('a meal read from an electronic invoice takes its tax groups as the meal\'s lines', async () => {
    const fields = await fieldsOf(UBL_INVOICE);
    const meal = settle(fields.text, answer({ category: 'Bewirtung', meal: { ...EMPTY_MEAL_CLASSIFICATION, taxLines: [{ rate: 7, net: 1, tax: 0.07 }] } }));
    expect(withStructuredInvoice(meal, fields).meal?.taxLines).toEqual([
      { rate: 19, net: 100, tax: 19 },
      { rate: 7, net: 50, tax: 3.5 },
    ]);
  });
});
