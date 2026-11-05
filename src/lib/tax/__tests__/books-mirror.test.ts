import { describe, expect, it } from 'vitest';
import { parseBooksDocuments, planMirror, treatmentOf, type BooksDocument, type MirrorRow } from '../books-mirror';

const doc = (o: Partial<BooksDocument> = {}): BooksDocument => ({
  id: 'doc-62',
  docType: 'invoice',
  status: 'issued',
  number: '62',
  issueDate: '2026-10-28',
  dueDate: '2026-11-11',
  currencyCode: 'EUR',
  kleinunternehmer: true,
  reverseCharge: false,
  totalCents: 75_000,
  taxCents: 0,
  taxSummary: [{ rateBp: 0, netCents: 75_000, taxCents: 0 }],
  correctsDocumentId: null,
  replacesDocumentId: null,
  ...o,
});

const row = (o: Partial<MirrorRow> = {}): MirrorRow => ({
  id: 'row-61',
  number: '61',
  source: 'register',
  booksDocumentId: null,
  issueDate: '2026-10-01',
  grossCents: 50_000,
  vatCents: 0,
  treatment: 'small_business',
  taxGroups: null,
  dueDate: null,
  cancelledOn: null,
  replacesInvoiceId: null,
  ...o,
});

describe('parseBooksDocuments', () => {
  it('takes issued invoices and credit notes and leaves offers and drafts out', () => {
    const { documents, refused } = parseBooksDocuments([doc(), { ...doc({ id: 'o1' }), docType: 'offer' }, doc({ id: 'd1', status: 'draft' as never }), doc({ id: 'cn', docType: 'credit_note', correctsDocumentId: 'doc-62' })]);
    expect(documents.map((d) => d.id)).toEqual(['doc-62', 'cn']);
    expect(refused).toEqual([]);
  });

  it('reports an unreadable document by its number instead of dropping it', () => {
    const { documents, refused } = parseBooksDocuments([doc({ totalCents: -5 }), doc({ id: 'x', number: '64', issueDate: '2026-13-01' }), doc({ id: 'cn', number: 'G-1', docType: 'credit_note', correctsDocumentId: null })]);
    expect(documents).toEqual([]);
    expect(refused).toEqual([
      { number: '62', reason: 'invalid_document' },
      { number: '64', reason: 'invalid_document' },
      { number: 'G-1', reason: 'invalid_document' },
    ]);
  });

  it('refuses a body that is no list at all', () => {
    expect(() => parseBooksDocuments({ documents: [] })).toThrow(/array/);
  });
});

describe('treatmentOf', () => {
  it('maps the small-business rule, reverse charge, one rate and several rates', () => {
    expect(treatmentOf(doc())).toEqual({ treatment: 'small_business', taxGroups: null });
    expect(treatmentOf(doc({ kleinunternehmer: false, reverseCharge: true }))).toEqual({ treatment: 'not_taxable', taxGroups: null });
    expect(treatmentOf(doc({ kleinunternehmer: false, totalCents: 11_900, taxCents: 1_900, taxSummary: [{ rateBp: 1900, netCents: 10_000, taxCents: 1_900 }] }))).toEqual({ treatment: 'standard', taxGroups: null });
    expect(treatmentOf(doc({ kleinunternehmer: false, totalCents: 10_700, taxCents: 700, taxSummary: [{ rateBp: 700, netCents: 10_000, taxCents: 700 }] }))).toEqual({ treatment: 'reduced', taxGroups: null });
    const mixed = doc({
      kleinunternehmer: false,
      totalCents: 22_600,
      taxCents: 2_600,
      taxSummary: [
        { rateBp: 700, netCents: 10_000, taxCents: 700 },
        { rateBp: 1900, netCents: 10_000, taxCents: 1_900 },
      ],
    });
    expect(treatmentOf(mixed)).toEqual({
      treatment: 'mixed',
      taxGroups: [
        { rateBp: 1900, netCents: 10_000, vatCents: 1_900 },
        { rateBp: 700, netCents: 10_000, vatCents: 700 },
      ],
    });
  });

  it('cannot hold tax under the small-business rule, another rate, or groups that do not add up', () => {
    expect(treatmentOf(doc({ taxCents: 100 }))).toBeNull();
    expect(treatmentOf(doc({ kleinunternehmer: false, totalCents: 11_600, taxCents: 1_600, taxSummary: [{ rateBp: 1600, netCents: 10_000, taxCents: 1_600 }] }))).toBeNull();
    expect(treatmentOf(doc({ kleinunternehmer: false, totalCents: 12_000, taxCents: 1_900, taxSummary: [{ rateBp: 1900, netCents: 10_000, taxCents: 1_900 }] }))).toBeNull();
  });
});

describe('planMirror', () => {
  it('creates a row for a new invoice, with its due day', () => {
    const plan = planMirror([row()], [doc()]);
    expect(plan.writes).toEqual([
      {
        documentId: 'doc-62',
        rowId: null,
        attach: false,
        replacesDocumentId: null,
        fields: { number: '62', issueDate: '2026-10-28', grossCents: 75_000, vatCents: 0, treatment: 'small_business', taxGroups: null, dueDate: '2026-11-11', cancelledOn: null },
      },
    ]);
    expect(plan.conflicts).toEqual([]);
  });

  it('changes nothing when the same documents come again', () => {
    const mirrored = row({ id: 'row-62', number: '62', source: 'books', booksDocumentId: 'doc-62', issueDate: '2026-10-28', grossCents: 75_000, dueDate: '2026-11-11' });
    const plan = planMirror([row(), mirrored], [doc()]);
    expect(plan.writes).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('attaches a register row of the same number and figures, and fills an issue day the row lacks', () => {
    const plan = planMirror([row(), row({ id: 'row-34', number: '34', issueDate: null, grossCents: 30_000 })], [doc({ id: 'doc-61', number: '61', issueDate: '2026-10-01', totalCents: 50_000, taxSummary: [] }), doc({ id: 'doc-34', number: '34', issueDate: '2024-06-03', totalCents: 30_000 })]);
    expect(plan.writes.map((w) => [w.documentId, w.rowId, w.attach, w.fields.issueDate])).toEqual([
      ['doc-61', 'row-61', true, '2026-10-01'],
      ['doc-34', 'row-34', true, '2024-06-03'],
    ]);
  });

  it('leaves a register row whose figures differ untouched and reports it', () => {
    const plan = planMirror([row()], [doc({ id: 'doc-61', number: '61', issueDate: '2026-10-01', totalCents: 51_000 }), doc({ id: 'doc-61b', number: '61', issueDate: '2026-10-02', totalCents: 50_000 })]);
    expect(plan.writes).toEqual([]);
    expect(plan.conflicts).toEqual([
      { number: '61', reason: 'register_differs' },
      { number: '61', reason: 'register_differs' },
    ]);
  });

  it('skips what is older than the register and what is not in euro', () => {
    const plan = planMirror([row({ issueDate: '2024-02-01' })], [doc({ id: 'd23', number: '23', issueDate: '2022-05-01' }), doc({ id: 'd64', number: '64', currencyCode: 'CHF' })]);
    expect(plan.writes).toEqual([]);
    expect(plan.skipped).toEqual([
      { number: '23', reason: 'before_register' },
      { number: '64', reason: 'not_euro' },
    ]);
  });

  it('mirrors everything when the company holds no invoice yet', () => {
    const plan = planMirror([], [doc({ id: 'd1', number: '1', issueDate: '2019-01-10' })]);
    expect(plan.writes).toHaveLength(1);
  });

  it('refuses a number another Books document already holds', () => {
    const plan = planMirror([row({ number: '62', source: 'books', booksDocumentId: 'other' })], [doc()]);
    expect(plan.conflicts).toEqual([{ number: '62', reason: 'number_taken' }]);
    expect(plan.writes).toEqual([]);
  });

  it('cancels an invoice on the day of its credit note, in the same pull or a later one', () => {
    const credit = doc({ id: 'cn-1', docType: 'credit_note', number: 'G-1', issueDate: '2026-11-02', correctsDocumentId: 'doc-62' });
    const same = planMirror([], [doc({ status: 'cancelled' }), credit]);
    expect(same.writes[0].fields.cancelledOn).toBe('2026-11-02');
    expect(same.conflicts).toEqual([]);

    const mirrored = row({ id: 'row-62', number: '62', source: 'books', booksDocumentId: 'doc-62', issueDate: '2026-10-28', grossCents: 75_000, dueDate: '2026-11-11' });
    const later = planMirror([mirrored], [credit]);
    expect(later.writes.map((w) => [w.rowId, w.fields.cancelledOn])).toEqual([['row-62', '2026-11-02']]);
    // Once cancelled, the same credit note again changes nothing.
    expect(planMirror([{ ...mirrored, cancelledOn: '2026-11-02' }], [credit]).writes).toEqual([]);
  });

  it('reports a partial credit note, a credit note without its invoice and a cancellation without a credit note', () => {
    const plan = planMirror(
      [],
      [
        doc({ status: 'cancelled' }),
        doc({ id: 'cn-1', docType: 'credit_note', number: 'G-1', correctsDocumentId: 'doc-62', totalCents: 10_000 }),
        doc({ id: 'cn-2', docType: 'credit_note', number: 'G-2', correctsDocumentId: 'nowhere' }),
      ],
    );
    expect(plan.conflicts).toEqual([
      { number: '62', reason: 'partial_credit_note' },
      { number: 'G-2', reason: 'credit_note_without_invoice' },
      { number: '62', reason: 'cancelled_without_credit_note' },
    ]);
    expect(plan.writes[0].fields.cancelledOn).toBeNull();
  });

  it('carries the replaced document of a corrected invoice until the link is made', () => {
    const replacement = doc({ id: 'doc-63', number: '63', replacesDocumentId: 'doc-62' });
    expect(planMirror([], [replacement]).writes[0].replacesDocumentId).toBe('doc-62');
    const linked = row({ id: 'row-63', number: '63', source: 'books', booksDocumentId: 'doc-63', issueDate: '2026-10-28', grossCents: 75_000, dueDate: '2026-11-11', replacesInvoiceId: 'row-62' });
    expect(planMirror([linked], [replacement]).writes).toEqual([]);
  });
});
