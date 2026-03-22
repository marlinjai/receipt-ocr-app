import { describe, it, expect } from 'vitest';
import { extractReceiptFields } from '@/lib/extract-receipt-fields';
import type { OcrResult } from '@/lib/ocr-types';

// ── Helpers ──────────────────────────────────────────────────────────

/** Build a minimal OcrResult from plain text (no spatial blocks). */
function makeOcr(fullText: string, blocks?: OcrResult['blocks']): OcrResult {
  return {
    fullText,
    blocks: blocks ?? [],
    confidence: 0.95,
  };
}

/** Build OcrResult with spatial blocks (first block = top-most). */
function makeOcrWithBlocks(
  fullText: string,
  blockTexts: string[],
): OcrResult {
  return {
    fullText,
    blocks: blockTexts.map((text, i) => ({
      text,
      boundingBox: { x: 0, y: i * 50, width: 200, height: 40 },
      confidence: 0.95,
    })),
    confidence: 0.95,
  };
}

// ── Amount Extraction ────────────────────────────────────────────────

describe('extractAmounts (via extractReceiptFields)', () => {
  it('parses US-format total with dollar sign', () => {
    const ocr = makeOcr('Items\nTotal: $234.56');
    const result = extractReceiptFields(ocr);
    expect(result.gross).toBe(234.56);
  });

  it('parses EU-format total with euro sign', () => {
    const ocr = makeOcr('Artikel\nGesamt: 234,56 €');
    const result = extractReceiptFields(ocr);
    expect(result.gross).toBe(234.56);
  });

  it('parses simple decimal amounts', () => {
    const ocr = makeOcr('Coffee\nTotal: 4.50');
    const result = extractReceiptFields(ocr);
    expect(result.gross).toBe(4.50);
  });

  it('extracts net (subtotal) and derives tax', () => {
    const ocr = makeOcr('Subtotal: $100.00\nTax: $19.00\nTotal: $119.00');
    const result = extractReceiptFields(ocr);
    expect(result.gross).toBe(119.00);
    expect(result.net).toBe(100.00);
    expect(result.taxRate).toBeCloseTo(19.0, 1);
  });

  it('derives net from gross and tax', () => {
    const ocr = makeOcr('Tax: $7.00\nTotal: $107.00');
    const result = extractReceiptFields(ocr);
    expect(result.gross).toBe(107.00);
    expect(result.net).toBe(100.00);
  });

  it('derives gross from net and tax when total label present', () => {
    const ocr = makeOcr('Netto: 50,00\nMwSt: 9,50\nGesamt: 59,50');
    const result = extractReceiptFields(ocr);
    expect(result.gross).toBe(59.50);
    expect(result.net).toBe(50.00);
  });

  it('prefers "Grand Total" over plain "Total"', () => {
    const ocr = makeOcr('Total: $50.00\nGrand Total: $55.00');
    const result = extractReceiptFields(ocr);
    expect(result.gross).toBe(55.00);
  });

  it('ignores subtotal when looking for gross', () => {
    const ocr = makeOcr('Sub Total: $80.00\nTax: $6.40\nTotal: $86.40');
    const result = extractReceiptFields(ocr);
    expect(result.gross).toBe(86.40);
    expect(result.net).toBe(80.00);
  });

  it('falls back to largest amount when no total label', () => {
    const ocr = makeOcr('Item A 12.50\nItem B 25.00\nItem C 8.75');
    const result = extractReceiptFields(ocr);
    expect(result.gross).toBe(25.00);
  });

  it('handles currency symbol before amount', () => {
    const ocr = makeOcr('Total: €42,50');
    const result = extractReceiptFields(ocr);
    expect(result.gross).toBe(42.50);
  });

  it('handles currency symbol after amount', () => {
    const ocr = makeOcr('Summe: 42,50€');
    const result = extractReceiptFields(ocr);
    expect(result.gross).toBe(42.50);
  });

  it('handles EU keywords like Gesamt and Brutto', () => {
    const ocr = makeOcr('Brutto: 119,00 €');
    const result = extractReceiptFields(ocr);
    expect(result.gross).toBe(119.00);
  });
});

// ── Date Extraction ──────────────────────────────────────────────────

describe('extractDate (via extractReceiptFields)', () => {
  it('parses ISO date (YYYY-MM-DD)', () => {
    const ocr = makeOcr('Date: 2024-03-15\nTotal: $10.00');
    const result = extractReceiptFields(ocr);
    expect(result.date).toBeTruthy();
    const d = new Date(result.date!);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(2); // March = 2
    expect(d.getDate()).toBe(15);
  });

  it('parses US date with slashes (MM/DD/YYYY)', () => {
    const ocr = makeOcr('Date: 03/15/2024\nTotal: $10.00');
    const result = extractReceiptFields(ocr);
    expect(result.date).toBeTruthy();
    const d = new Date(result.date!);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(15);
  });

  it('parses EU date with dots (DD.MM.YYYY)', () => {
    const ocr = makeOcr('Datum: 15.03.2024\nGesamt: 10,00 €');
    const result = extractReceiptFields(ocr);
    expect(result.date).toBeTruthy();
    const d = new Date(result.date!);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(15);
  });

  it('parses named month format (DD Month YYYY)', () => {
    const ocr = makeOcr('15 March 2024\nTotal: $10.00');
    const result = extractReceiptFields(ocr);
    expect(result.date).toBeTruthy();
    const d = new Date(result.date!);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(15);
  });

  it('parses named month first format (Month DD, YYYY)', () => {
    const ocr = makeOcr('Date: Mar 15, 2024\nTotal: $10.00');
    const result = extractReceiptFields(ocr);
    expect(result.date).toBeTruthy();
    const d = new Date(result.date!);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(15);
  });

  it('parses 2-digit year', () => {
    const ocr = makeOcr('Date: 03/15/24\nTotal: $5.00');
    const result = extractReceiptFields(ocr);
    expect(result.date).toBeTruthy();
    const d = new Date(result.date!);
    expect(d.getFullYear()).toBe(2024);
  });

  it('prefers labeled date over unlabeled', () => {
    const ocr = makeOcr('01.01.2020\nReceipt Date: 15.03.2024\nTotal: 10,00 €');
    const result = extractReceiptFields(ocr);
    expect(result.date).toBeTruthy();
    const d = new Date(result.date!);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(15);
  });

  it('skips expiry date lines', () => {
    const ocr = makeOcr('Card Exp: 12/25\nDate: 03/15/2024\nTotal: $10.00');
    const result = extractReceiptFields(ocr);
    expect(result.date).toBeTruthy();
    const d = new Date(result.date!);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(2);
  });

  it('returns null when no valid date found', () => {
    const ocr = makeOcr('Some random text\nTotal: $10.00');
    const result = extractReceiptFields(ocr);
    expect(result.date).toBeNull();
  });
});

// ── Vendor Extraction ────────────────────────────────────────────────

describe('extractVendor (via extractReceiptFields)', () => {
  it('extracts vendor from spatial blocks (top-most non-noise block)', () => {
    const ocr = makeOcrWithBlocks(
      'REWE\nFiliale 1234\nBrot 1,50\nGesamt: 1,50 €',
      ['REWE', 'Filiale 1234', 'Brot 1,50', 'Gesamt: 1,50 €'],
    );
    const result = extractReceiptFields(ocr);
    expect(result.vendor).toBe('REWE');
  });

  it('falls back to first non-noise line from fullText when no blocks', () => {
    const ocr = makeOcr('Starbucks Coffee\n123 Main St\nDate: 03/15/2024\nTotal: $5.50');
    const result = extractReceiptFields(ocr);
    expect(result.vendor).toBe('Starbucks Coffee');
  });

  it('skips generic headings like "Invoice" or "Receipt"', () => {
    const ocr = makeOcr('Invoice\nAcme Corp\n123 Business Ave\nTotal: $500.00');
    const result = extractReceiptFields(ocr);
    expect(result.vendor).toBe('Acme Corp');
  });

  it('skips pure-number lines', () => {
    const ocr = makeOcr('12345\nBest Buy\nTotal: $99.00');
    const result = extractReceiptFields(ocr);
    expect(result.vendor).toBe('Best Buy');
  });

  it('skips address lines', () => {
    const ocr = makeOcrWithBlocks(
      '123 Main Street\nTarget\nTotal: $50.00',
      ['123 Main Street', 'Target', 'Total: $50.00'],
    );
    const result = extractReceiptFields(ocr);
    expect(result.vendor).toBe('Target');
  });

  it('skips too-short lines', () => {
    const ocr = makeOcr('AB\nSupermarket XYZ\nTotal: $30.00');
    const result = extractReceiptFields(ocr);
    expect(result.vendor).toBe('Supermarket XYZ');
  });
});

// ── Category Inference ───────────────────────────────────────────────

describe('inferCategory (via extractReceiptFields)', () => {
  it('categorizes known vendor (Starbucks → Bewirtung)', () => {
    const ocr = makeOcrWithBlocks(
      'Starbucks\nLatte 4.50\nTotal: $4.50',
      ['Starbucks', 'Latte 4.50', 'Total: $4.50'],
    );
    const result = extractReceiptFields(ocr);
    expect(result.category).toBe('Bewirtung');
    expect(result.konto).toBe('4650');
  });

  it('categorizes known vendor (Lufthansa → Reisekosten)', () => {
    const ocr = makeOcrWithBlocks(
      'Lufthansa\nFlight LH123\nTotal: €350.00',
      ['Lufthansa', 'Flight LH123', 'Total: €350.00'],
    );
    const result = extractReceiptFields(ocr);
    expect(result.category).toBe('Reisekosten');
    expect(result.konto).toBe('4670');
  });

  it('categorizes by keyword when vendor is unknown (restaurant)', () => {
    const ocr = makeOcr('Joe\'s Diner\nRestaurant\nBurger 12.00\nTotal: $12.00');
    const result = extractReceiptFields(ocr);
    expect(result.category).toBe('Bewirtung');
  });

  it('categorizes by keyword (software/subscription)', () => {
    const ocr = makeOcr('Acme Inc\nSoftware License\nAnnual Subscription\nTotal: $299.00');
    const result = extractReceiptFields(ocr);
    expect(result.category).toBe('Software & Lizenzen');
  });

  it('categorizes by keyword (hotel/travel)', () => {
    const ocr = makeOcr('Grand Hotel\n2 nights accommodation\nCheck-in 03/15/2024\nTotal: $350.00');
    const result = extractReceiptFields(ocr);
    expect(result.category).toBe('Reisekosten');
  });

  it('categorizes by keyword (office supplies)', () => {
    const ocr = makeOcr('Shop XYZ\nPrinter Paper A4\nTotal: $15.00');
    const result = extractReceiptFields(ocr);
    expect(result.category).toBe('Bürobedarf');
  });

  it('categorizes known vendor (Adobe → Software & Lizenzen)', () => {
    const ocr = makeOcrWithBlocks(
      'Adobe Systems\nCreative Cloud\nMonthly: $54.99\nTotal: $54.99',
      ['Adobe Systems', 'Creative Cloud', 'Monthly: $54.99', 'Total: $54.99'],
    );
    const result = extractReceiptFields(ocr);
    expect(result.category).toBe('Software & Lizenzen');
    expect(result.konto).toBe('4806');
  });

  it('categorizes known vendor (Telekom → Telefon & Internet)', () => {
    const ocr = makeOcrWithBlocks(
      'Telekom\nMobilfunk Rechnung\nTotal: 39,99 €',
      ['Telekom', 'Mobilfunk Rechnung', 'Total: 39,99 €'],
    );
    const result = extractReceiptFields(ocr);
    expect(result.category).toBe('Telefon & Internet');
    expect(result.konto).toBe('4920');
  });

  it('falls back to Sonstige Ausgaben for unrecognized content', () => {
    const ocr = makeOcr('Random Shop\nMiscellaneous Item\nTotal: $25.00');
    const result = extractReceiptFields(ocr);
    expect(result.category).toBe('Sonstige Ausgaben');
    expect(result.konto).toBe('4900');
  });
});

// ── Tax Rate Calculation ─────────────────────────────────────────────

describe('taxRate calculation', () => {
  it('calculates 19% tax rate from gross and net', () => {
    const ocr = makeOcr('Netto: 100,00\nMwSt: 19,00\nGesamt: 119,00');
    const result = extractReceiptFields(ocr);
    expect(result.taxRate).toBeCloseTo(19.0, 1);
  });

  it('calculates 7% tax rate', () => {
    const ocr = makeOcr('Subtotal: $100.00\nTax: $7.00\nTotal: $107.00');
    const result = extractReceiptFields(ocr);
    expect(result.taxRate).toBeCloseTo(7.0, 1);
  });

  it('returns null taxRate when net is not available', () => {
    const ocr = makeOcr('Total: $50.00');
    const result = extractReceiptFields(ocr);
    expect(result.taxRate).toBeNull();
  });
});

// ── Full Receipt Samples ─────────────────────────────────────────────

describe('extractReceiptFields — full receipt samples', () => {
  it('German grocery receipt (REWE)', () => {
    const text = [
      'REWE',
      'Markt 4711',
      'Musterstraße 12',
      '10115 Berlin',
      '',
      'Vollmilch 3,5%        1,09',
      'Bio Brot              2,49',
      'Butter                1,99',
      'Äpfel 1kg             2,49',
      '',
      'Summe                 8,06',
      'Netto                 7,53',
      'MwSt 7%               0,53',
      '',
      'Datum: 15.03.2024',
      'Vielen Dank für Ihren Einkauf!',
    ].join('\n');

    const ocr = makeOcrWithBlocks(text, [
      'REWE', 'Markt 4711', 'Musterstraße 12', '10115 Berlin',
    ]);
    const result = extractReceiptFields(ocr);

    expect(result.vendor).toBe('REWE');
    expect(result.gross).toBe(8.06);
    expect(result.net).toBe(7.53);
    expect(result.category).toBe('Bewirtung');
    expect(result.konto).toBe('4650');
    expect(result.date).toBeTruthy();
    const d = new Date(result.date!);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(15);
    expect(result.name).toBeTruthy();
    expect(result.name.length).toBeGreaterThan(0);
  });

  it('US restaurant receipt', () => {
    const text = [
      'The Cheesecake Factory',
      '123 Restaurant Blvd',
      'Los Angeles, CA 90001',
      '',
      'Server: Mike',
      'Table: 12',
      '',
      '1 Chicken Sandwich       14.95',
      '1 Caesar Salad            9.95',
      '2 Iced Tea                5.90',
      '',
      'Subtotal:               $30.80',
      'Sales Tax:               $2.77',
      'Total:                  $33.57',
      '',
      'Date: 03/20/2024',
      'Thank you for dining with us!',
    ].join('\n');

    const ocr = makeOcrWithBlocks(text, [
      'The Cheesecake Factory', '123 Restaurant Blvd', 'Los Angeles, CA 90001',
    ]);
    const result = extractReceiptFields(ocr);

    expect(result.vendor).toBe('The Cheesecake Factory');
    expect(result.gross).toBe(33.57);
    expect(result.net).toBe(30.80);
    expect(result.category).toBe('Bewirtung');
    expect(result.date).toBeTruthy();
    const d = new Date(result.date!);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(20);
  });

  it('airline boarding pass / travel receipt', () => {
    const text = [
      'Lufthansa',
      'Booking Confirmation',
      '',
      'Flight: LH 1234',
      'Frankfurt (FRA) → New York (JFK)',
      'Date: 2024-06-15',
      '',
      'Passenger: Max Mustermann',
      'Class: Economy',
      '',
      'Fare:              €450.00',
      'Taxes & Fees:       €89.50',
      'Amount Due:        €539.50',
    ].join('\n');

    const ocr = makeOcrWithBlocks(text, [
      'Lufthansa', 'Booking Confirmation', 'Flight: LH 1234',
    ]);
    const result = extractReceiptFields(ocr);

    expect(result.vendor).toBe('Lufthansa');
    expect(result.gross).toBe(539.50);
    expect(result.category).toBe('Reisekosten');
    expect(result.konto).toBe('4670');
    expect(result.date).toBeTruthy();
    const d = new Date(result.date!);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(5); // June
    expect(d.getDate()).toBe(15);
  });

  it('software invoice (Vercel)', () => {
    const text = [
      'Vercel Inc.',
      'Invoice #INV-2024-0042',
      '',
      'Pro Plan - Monthly',
      'Period: Mar 1 – Mar 31, 2024',
      '',
      'Subscription:          $20.00',
      'Additional Usage:       $5.00',
      '',
      'Subtotal:              $25.00',
      'Tax (0%):               $0.00',
      'Total Due:             $25.00',
      '',
      'Invoice Date: March 31, 2024',
      'Payment Method: Visa ending 4242',
    ].join('\n');

    const ocr = makeOcrWithBlocks(text, [
      'Vercel Inc.', 'Invoice #INV-2024-0042', 'Pro Plan - Monthly',
    ]);
    const result = extractReceiptFields(ocr);

    expect(result.vendor).toBe('Vercel Inc.');
    expect(result.gross).toBe(25.00);
    expect(result.net).toBe(25.00);
    expect(result.category).toBe('Software & Lizenzen');
    expect(result.konto).toBe('4806');
    expect(result.date).toBeTruthy();
    const d = new Date(result.date!);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(2); // March
    expect(d.getDate()).toBe(31);
  });
});

// ── Name Generation ──────────────────────────────────────────────────

describe('name generation', () => {
  it('generates a name from vendor, items, amount, and date', () => {
    const ocr = makeOcrWithBlocks(
      'Starbucks\nCappuccino 3.50\nTotal: $3.50\nDate: 03/15/2024',
      ['Starbucks'],
    );
    const result = extractReceiptFields(ocr);
    expect(result.name).toContain('Starbucks');
    expect(result.name).toContain('3.50');
  });

  it('returns "Receipt" as absolute fallback for empty/noise-only text', () => {
    const ocr = makeOcr('   \n\n  ');
    const result = extractReceiptFields(ocr);
    expect(result.name).toBe('Receipt');
  });
});
