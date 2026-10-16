import { describe, expect, it, vi } from 'vitest';
import { readStructuredInvoice, structuredReceiptFields } from '@/lib/einvoice';
import { CII_INVOICE, UBL_CREDIT_NOTE } from '@/lib/einvoice/__tests__/samples';
import { carriesInvoiceNumber, findInvoiceRow } from '../receipt-references';

/** The credit note sample with the invoice it corrects named (BT-25). */
const UBL_CREDIT_NOTE_WITH_REFERENCE = UBL_CREDIT_NOTE.replace(
  '<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>',
  '<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>\n  <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>R-2026-17</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>',
);

const fieldsOf = async (xml: string) => structuredReceiptFields((await readStructuredInvoice(new TextEncoder().encode(xml)))!.invoice);

describe('the invoice a credit note corrects', () => {
  it('is read from the XML in both syntaxes, and said in its text', async () => {
    const ubl = await fieldsOf(UBL_CREDIT_NOTE_WITH_REFERENCE);
    expect(ubl.referencedInvoiceNumber).toBe('R-2026-17');
    expect(ubl.text).toContain('Bezieht sich auf Rechnung: R-2026-17');
    const cii = CII_INVOICE.replace(
      '<ram:ApplicableHeaderTradeSettlement>',
      '<ram:ApplicableHeaderTradeSettlement>\n      <ram:InvoiceReferencedDocument><ram:IssuerAssignedID>R-2026-9</ram:IssuerAssignedID></ram:InvoiceReferencedDocument>',
    );
    expect((await fieldsOf(cii)).referencedInvoiceNumber).toBe('R-2026-9');
    expect((await fieldsOf(UBL_CREDIT_NOTE)).referencedInvoiceNumber).toBeNull();
  });

  it('a number is carried as a whole token only', () => {
    expect(carriesInvoiceNumber('Rechnungsnummer: R-2026-17\nGesamt 11,90', 'R-2026-17')).toBe(true);
    expect(carriesInvoiceNumber('Rechnungsnummer: R-2026-170', 'R-2026-17')).toBe(false);
    expect(carriesInvoiceNumber('Rechnungsnummer: XR-2026-17', 'R-2026-17')).toBe(false);
    expect(carriesInvoiceNumber('Invoice r-2026-17.', 'R-2026-17')).toBe(true);
    expect(carriesInvoiceNumber('Nr 17', '17')).toBe(false);
  });

  it('exactly one other receipt carrying the number is the invoice; none or several are not', async () => {
    const columns = [{ id: 't', name: 'OCR Text' }];
    const adapter = (rows: Array<{ id: string; text: string }>) => ({
      getColumns: async () => columns,
      getRows: vi.fn(async () => ({ items: rows.map((r) => ({ id: r.id, cells: { t: r.text } })), hasMore: false })),
    });
    expect(await findInvoiceRow(adapter([{ id: 'inv', text: 'Rechnung R-2026-17' }, { id: 'self', text: 'Gutschrift zu R-2026-17' }]), 'tbl', 'R-2026-17', 'self')).toBe('inv');
    expect(await findInvoiceRow(adapter([{ id: 'a', text: 'R-2026-17' }, { id: 'b', text: 'R-2026-17' }]), 'tbl', 'R-2026-17', 'self')).toBeNull();
    expect(await findInvoiceRow(adapter([{ id: 'a', text: 'R-2026-170' }]), 'tbl', 'R-2026-17', 'self')).toBeNull();
  });
});
