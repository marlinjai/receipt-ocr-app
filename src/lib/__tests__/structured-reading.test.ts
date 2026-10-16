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
    const named = settle(fields.text, answer({ vendor: 'Muster Software' }));
    expect(withStructuredInvoice(named, fields).vendor).toBe('Muster Software');
    const unnamed = { ...named, vendor: null };
    expect(withStructuredInvoice(unnamed, fields).vendor).toBe(fields.vendor);
  });

  it('an XRechnung without a page: its figures as text are read, and the reading says nothing about a page', async () => {
    const fields = await fieldsOf(CII_INVOICE);
    const settled = withStructuredInvoice(settle(fields.text, answer({ sawPage: false })), fields);
    expect(settled.flags).not.toContain('page_not_read');
    expect(settled.gross).toBe(fields.gross);
  });

  it('a credit note is put up for a look; so are figures that do not add up', async () => {
    const credit = await fieldsOf(UBL_CREDIT_NOTE);
    expect(withStructuredInvoice(settle(credit.text, answer()), credit).flags).toContain('credit_note');
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
