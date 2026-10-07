import { describe, expect, it } from 'vitest';
import { extractReceiptFields } from '@/lib/extract-receipt-fields';
import { CATEGORY_TO_KONTO, ZUORDNUNG_OPTIONS } from '@/lib/receipts-constants';
import { receiptAttention } from '@/lib/upload/quality';
import { parseClassificationResponse } from '@/lib/web-search';
import { defaultTaxRate, extractTipFromText, mealFactsFromClassification, parseMealClassification } from '../classify';

const INPUT = {
  categoryNames: Object.keys(CATEGORY_TO_KONTO),
  categoryToKonto: CATEGORY_TO_KONTO,
  zuordnungOptions: ZUORDNUNG_OPTIONS,
};

/**
 * An answer in the exact shape the prompt in web-search.ts asks for, as the
 * model returns it: prose from the web search first, then the object in a code
 * fence. It runs through the REAL parser, not a mock. (It is written to the
 * contract, not captured from a live call: no model credentials are available
 * to the test environment.)
 */
const ANSWER_2026_MIXED_RATES = `I searched for the vendor: Gasthaus Beispiel is a restaurant in Musterstadt.

\`\`\`json
{
  "name": "Abendessen (3 Personen), Gasthaus Beispiel, 80,70, 03.02.2026",
  "category": "Bewirtung",
  "konto": "4650",
  "zuordnung": "Geschäftlich",
  "taxRate": 7,
  "taxLines": [
    { "rate": 7, "net": 50.0, "tax": 3.5 },
    { "rate": 19, "net": 22.86, "tax": 4.34 }
  ],
  "mealType": "business_meal_external",
  "consumption": "dine_in",
  "tip": 8,
  "place": "Gasthaus Beispiel,  Musterstraße 1,\\n12345 Musterstadt",
  "confidence": 0.92,
  "reasoning": "Restaurant receipt with food at 7 percent and drinks at 19 percent."
}
\`\`\``;

describe('parseClassificationResponse (real parser)', () => {
  it('reads category, both tax lines and the meal facts from a full answer', () => {
    const result = parseClassificationResponse(ANSWER_2026_MIXED_RATES, INPUT);
    expect(result).toMatchObject({
      category: 'Bewirtung',
      konto: '4650',
      zuordnung: 'Geschäftlich',
      taxRate: 7,
      confidence: 0.92,
      meal: {
        mealType: 'business_meal_external',
        consumption: 'dine_in',
        tip: 8,
        taxLines: [
          { rate: 7, net: 50, tax: 3.5 },
          { rate: 19, net: 22.86, tax: 4.34 },
        ],
        place: 'Gasthaus Beispiel, Musterstraße 1, 12345 Musterstadt',
      },
    });
  });

  it('an answer without the meal fields (the shape before this change) still parses', () => {
    const result = parseClassificationResponse(
      '{ "name": "USB Kabel", "category": "Hardware & IT", "konto": "4855", "zuordnung": "Geschäftlich", "taxRate": 19, "confidence": 0.8, "reasoning": "x" }',
      INPUT,
    );
    expect(result.category).toBe('Hardware & IT');
    expect(result.meal).toEqual({ mealType: null, consumption: null, tip: null, taxLines: null, place: null });
  });

  it('rejects values outside the contract field by field instead of passing them on', () => {
    const result = parseClassificationResponse(
      JSON.stringify({
        category: 'Lebensmittel', zuordnung: 'Hobby', taxRate: '19',
        mealType: 'banquet', consumption: 'buffet', tip: -4, place: 42,
        taxLines: [{ rate: 19, net: 'zehn', tax: 1.9 }],
      }),
      INPUT,
    );
    expect(result).toMatchObject({ category: null, zuordnung: null, taxRate: null });
    expect(result.meal).toEqual({ mealType: null, consumption: null, tip: null, taxLines: null, place: null });
  });

  it('garbage degrades to an empty classification, never a throw', () => {
    const result = parseClassificationResponse('Sorry, I could not classify this.', INPUT);
    expect(result).toMatchObject({ category: null, confidence: 0 });
    expect(result.meal.mealType).toBeNull();
  });
});

describe('parseMealClassification', () => {
  it.each([null, undefined, 'x', 5, []])('reads %j as nothing said', (raw) => {
    expect(parseMealClassification(raw)).toEqual({ mealType: null, consumption: null, tip: null, taxLines: null, place: null });
  });
});

describe('tip from the receipt text', () => {
  it.each([
    ['Summe 48,50\nTrinkgeld 5,00\nGesamt 53,50', 5],
    ['TIP: 4.50', 4.5],
    ['Trinkgeld € 3,00', 3],
  ])('finds it in %j', (text, tip) => {
    expect(extractTipFromText(text)).toBe(tip);
  });
  it.each(['Summe 48,50', 'Trinkgeld ist nicht enthalten', 'Tip not included 0,00', 'Service inkl. 5,00'])(
    'finds none in %j',
    (text) => {
      expect(extractTipFromText(text)).toBeNull();
    },
  );
  it('the classifier value wins over the text; the text is the fallback', () => {
    const meal = { mealType: null, consumption: null, tip: 8, taxLines: null, place: null };
    expect(mealFactsFromClassification({ meal }, 'Trinkgeld 5,00').tip).toBe(8);
    expect(mealFactsFromClassification({ meal: { ...meal, tip: null } }, 'Trinkgeld 5,00').tip).toBe(5);
    expect(mealFactsFromClassification(null, 'Trinkgeld 5,00').tip).toBe(5);
  });
});

describe('default tax rate: date- and item-aware', () => {
  it('restaurant meal: 19 percent in 2025, 7 percent from 2026', () => {
    expect(defaultTaxRate('Bewirtung', '2025-12-31', null)).toBe(19);
    expect(defaultTaxRate('Bewirtung', '2026-01-01', null)).toBe(7);
    expect(defaultTaxRate('Bewirtung', '2025-06-01T12:00:00.000Z', 'takeaway')).toBe(7);
    expect(defaultTaxRate('Bewirtung', null, null)).toBe(19);
  });
  it('books 7 percent, everything else 19', () => {
    expect(defaultTaxRate('Fachliteratur', '2025-01-01', null)).toBe(7);
    expect(defaultTaxRate('Hardware & IT', '2026-01-01', null)).toBe(19);
    expect(defaultTaxRate(null, null, null)).toBe(19);
  });
});

describe('fallback rules (no classifier)', () => {
  const ocr = (fullText: string) => ({ fullText, blocks: [], confidence: 0.9 });

  it('a supermarket receipt is not filed as a business meal', () => {
    for (const vendor of ['REWE Markt GmbH', 'ALDI SÜD', 'Lidl', 'EDEKA Beispiel']) {
      const result = extractReceiptFields(ocr(`${vendor}\nBananen 1,99\nSumme 1,99\n02.03.2025`));
      expect(result.category, vendor).not.toBe('Bewirtung');
    }
  });

  it('a restaurant receipt still is, with the rate of its date when none is printed', () => {
    const y2025 = extractReceiptFields(ocr('Ristorante Beispiel\nPizza Margherita 12,00\nSumme 12,00\n02.03.2025'));
    expect(y2025.category).toBe('Bewirtung');
    expect(y2025.taxRate).toBe(19);
    const y2026 = extractReceiptFields(ocr('Ristorante Beispiel\nPizza Margherita 12,00\nSumme 12,00\n02.03.2026'));
    expect(y2026.category).toBe('Bewirtung');
    expect(y2026.taxRate).toBe(7);
  });
});

describe('receiptAttention', () => {
  it('a failed recognition, a blurry photo and a missing total or date each ask for attention', () => {
    expect(receiptAttention({ ocrOk: false, confidence: null, gross: null, date: null })).toBe('ocr_failed');
    expect(receiptAttention({ ocrOk: true, confidence: 59, gross: 12, date: '2025-01-01' })).toBe('low_quality');
    expect(receiptAttention({ ocrOk: true, confidence: 95, gross: null, date: '2025-01-01' })).toBe('low_quality');
    expect(receiptAttention({ ocrOk: true, confidence: 95, gross: 12, date: null })).toBe('low_quality');
  });
  it('a well-read receipt does not', () => {
    expect(receiptAttention({ ocrOk: true, confidence: 60, gross: 12, date: '2025-01-01' })).toBeNull();
  });
});
