import { isIsoDay } from './decisions';
import { INVOICE_RATES_BP } from './invoice-tax';
import type { InvoiceTreatment, TaxGroup } from './types';

/**
 * The read-only mirror of the invoices framer-clone's Books issue (step 4 of
 * the invoicing plan, docs/plans/2026-10-14-invoicing-and-income.md). Pure:
 * it reads the issued documents and the invoices this app holds and says what
 * to write. The service applies it in one transaction.
 *
 * The invoice exists once, as the Books document; this app keeps a copy no
 * person types (`source = 'books'`), plus everything that is this app's own:
 * the payments, the links to bank payments, what a return declared, what was
 * booked out. Three rules carry it:
 *
 * - **Same number, same invoice.** The register rows (invoices entered here
 *   from their PDFs) and the Books share one number series, because the Books
 *   imported the whole series. A document whose number a register row holds
 *   is that row when the figures agree (total, tax treatment, and the issue
 *   day where the row has one): the row is attached and becomes a mirror
 *   row, payments and all. When they differ, nothing is touched and the
 *   difference is reported, because which figure is right is a person's call.
 * - **A credit note cancels its invoice** on the credit note's day: from then
 *   on the invoice is no claim. Only a credit note over the whole invoice is
 *   taken (the Books issue no other); a partial one is reported.
 * - **A corrected invoice takes over the payments** of the invoice it
 *   replaces (`replaces_document_id` in the Books): the money arrived for the
 *   corrected invoice, so it is income of the replacement, never a payment of
 *   a cancelled invoice next to an unpaid one. The move happens once, when the
 *   replacement first arrives; a payment a person links to the old invoice
 *   later stays where the person put it.
 *
 * Documents older than the invoices this app holds (before the first year of
 * its register) and documents in another currency are skipped and reported:
 * this app counts income in euro and from its first year on.
 */

/** One issued document as the Books hand it over: the fields of framer-clone's `sales_document` this app needs. */
export interface BooksDocument {
  /** `sales_document.id`. */
  id: string;
  docType: 'invoice' | 'credit_note';
  /** `issued`, `sent` and `paid` are live invoices; `cancelled` was cancelled by a credit note. */
  status: 'issued' | 'sent' | 'paid' | 'cancelled';
  /** The printed number (`document_number`). */
  number: string;
  /** ISO day. */
  issueDate: string;
  /** ISO day, or null when the document states none. */
  dueDate: string | null;
  currencyCode: string;
  /** The document was issued under the small-business rule (section 19). */
  kleinunternehmer: boolean;
  /** The customer owes the tax (reverse charge). */
  reverseCharge: boolean;
  /** Cents, never negative (a credit note states its own amount positive). */
  totalCents: number;
  taxCents: number;
  /** One group per rate and treatment; rates in basis points. */
  taxSummary: Array<{ rateBp: number; netCents: number; taxCents: number }>;
  /** A credit note: the invoice it cancels. */
  correctsDocumentId: string | null;
  /** A corrected invoice: the invoice it replaces. */
  replacesDocumentId: string | null;
}

/** An invoice this app holds, as far as the mirror needs it. */
export interface MirrorRow {
  id: string;
  number: string;
  source: 'register' | 'books';
  booksDocumentId: string | null;
  issueDate: string | null;
  grossCents: number;
  vatCents: number;
  treatment: string;
  taxGroups: TaxGroup[] | null;
  dueDate: string | null;
  cancelledOn: string | null;
  replacesInvoiceId: string | null;
}

/** What a mirror row holds from its Books document. */
export interface MirrorFields {
  number: string;
  issueDate: string;
  grossCents: number;
  vatCents: number;
  treatment: InvoiceTreatment;
  taxGroups: TaxGroup[] | null;
  dueDate: string | null;
  cancelledOn: string | null;
}

export interface MirrorWrite {
  documentId: string;
  /** The row to write into; null: a new row. */
  rowId: string | null;
  /** A register row becomes a mirror row with this write. */
  attach: boolean;
  fields: MirrorFields;
  /** The Books document this invoice replaces; its row's payments move here when the link is new. */
  replacesDocumentId: string | null;
}

export type MirrorSkipReason =
  /** Issued before the first year of the invoices this app holds. */
  | 'before_register'
  /** In another currency than the euro. */
  | 'not_euro';

export type MirrorConflictReason =
  /** A register row holds the number with another total, treatment or issue day. */
  | 'register_differs'
  /** The number belongs to a row that mirrors another Books document. */
  | 'number_taken'
  /** A credit note over less (or more) than the whole invoice. */
  | 'partial_credit_note'
  /** A credit note whose invoice is not among the documents. */
  | 'credit_note_without_invoice'
  /** The Books say cancelled, but no credit note came with it. */
  | 'cancelled_without_credit_note'
  /** A tax this app cannot hold on an invoice: a rate other than 19 or 7 percent, or tax next to an untaxed group. */
  | 'unsupported_tax'
  /** The document is not readable (a figure missing or impossible). */
  | 'invalid_document';

export interface MirrorPlan {
  writes: MirrorWrite[];
  /** Documents whose row already holds exactly what they say. */
  unchanged: number;
  skipped: Array<{ number: string; reason: MirrorSkipReason }>;
  conflicts: Array<{ number: string; reason: MirrorConflictReason }>;
}

const LIVE_STATUSES: ReadonlySet<string> = new Set(['issued', 'sent', 'paid', 'cancelled']);
const MAX_CENTS = 1_000_000_000;
const isCents = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_CENTS;
const isText = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const optionalText = (v: unknown): string | null => (isText(v) ? v : null);

/**
 * Read what the Books hand over. Offers, drafts and anything unreadable are
 * left out; an unreadable document is reported by its number (or id) so a
 * person sees it, never silently dropped.
 */
export function parseBooksDocuments(raw: unknown): { documents: BooksDocument[]; refused: Array<{ number: string; reason: 'invalid_document' }> } {
  if (!Array.isArray(raw)) throw new Error('parseBooksDocuments: expected an array of documents');
  const documents: BooksDocument[] = [];
  const refused: Array<{ number: string; reason: 'invalid_document' }> = [];
  for (const entry of raw) {
    const d = (entry ?? {}) as Record<string, unknown>;
    // Offers and drafts are no issued invoices; they are not the mirror's business.
    if (d.docType !== 'invoice' && d.docType !== 'credit_note') continue;
    if (typeof d.status !== 'string' || !LIVE_STATUSES.has(d.status)) continue;
    const summary = Array.isArray(d.taxSummary) ? d.taxSummary.map((g) => (g ?? {}) as Record<string, unknown>) : null;
    const readable =
      isText(d.id) &&
      isText(d.number, 60) &&
      isIsoDay(d.issueDate) &&
      (d.dueDate === null || d.dueDate === undefined || isIsoDay(d.dueDate)) &&
      isText(d.currencyCode, 3) &&
      typeof d.kleinunternehmer === 'boolean' &&
      typeof d.reverseCharge === 'boolean' &&
      isCents(d.totalCents) &&
      isCents(d.taxCents) &&
      d.taxCents <= d.totalCents &&
      summary !== null &&
      summary.every((g) => Number.isInteger(g.rateBp) && (g.rateBp as number) >= 0 && (g.rateBp as number) <= 10_000 && isCents(g.netCents) && isCents(g.taxCents)) &&
      (d.docType !== 'credit_note' || isText(d.correctsDocumentId));
    if (!readable) {
      refused.push({ number: isText(d.number, 60) ? d.number : isText(d.id) ? d.id : '?', reason: 'invalid_document' });
      continue;
    }
    documents.push({
      id: d.id as string,
      docType: d.docType,
      status: d.status as BooksDocument['status'],
      number: (d.number as string).trim(),
      issueDate: d.issueDate as string,
      dueDate: (d.dueDate as string | null | undefined) ?? null,
      currencyCode: (d.currencyCode as string).toUpperCase(),
      kleinunternehmer: d.kleinunternehmer as boolean,
      reverseCharge: d.reverseCharge as boolean,
      totalCents: d.totalCents as number,
      taxCents: d.taxCents as number,
      taxSummary: (summary as Array<Record<string, number>>).map((g) => ({ rateBp: g.rateBp, netCents: g.netCents, taxCents: g.taxCents })),
      correctsDocumentId: optionalText(d.correctsDocumentId),
      replacesDocumentId: optionalText(d.replacesDocumentId),
    });
  }
  return { documents, refused };
}

/**
 * How the invoice is taxed, in this app's terms, from the Books document:
 * small business, the customer owes the tax, one rate (19 or 7 percent) or
 * several. Null when this app cannot hold it.
 */
export function treatmentOf(document: BooksDocument): { treatment: InvoiceTreatment; taxGroups: TaxGroup[] | null } | null {
  if (document.kleinunternehmer) return document.taxCents === 0 ? { treatment: 'small_business', taxGroups: null } : null;
  if (document.reverseCharge || document.taxCents === 0) {
    return document.taxCents === 0 ? { treatment: 'not_taxable', taxGroups: null } : null;
  }
  // Tax per rate; a group of another rate, or an untaxed group next to taxed ones, does not fit the invoice record.
  const byRate = new Map<number, TaxGroup>();
  for (const g of document.taxSummary) {
    if (g.netCents === 0 && g.taxCents === 0) continue;
    if (!INVOICE_RATES_BP.includes(g.rateBp) || g.taxCents === 0) return null;
    const group = byRate.get(g.rateBp) ?? { rateBp: g.rateBp, netCents: 0, vatCents: 0 };
    group.netCents += g.netCents;
    group.vatCents += g.taxCents;
    byRate.set(g.rateBp, group);
  }
  const groups = [...byRate.values()].sort((a, b) => b.rateBp - a.rateBp);
  if (groups.length === 0) return null;
  if (groups.reduce((s, g) => s + g.netCents + g.vatCents, 0) !== document.totalCents) return null;
  if (groups.reduce((s, g) => s + g.vatCents, 0) !== document.taxCents) return null;
  if (groups.length > 1) return { treatment: 'mixed', taxGroups: groups };
  return { treatment: groups[0].rateBp === 1900 ? 'standard' : 'reduced', taxGroups: null };
}

/** The groups of a rate each, in one order and one shape, so two spellings of the same groups compare equal. */
const canonical = (groups: TaxGroup[] | null) =>
  groups === null ? null : [...groups].sort((a, b) => b.rateBp - a.rateBp).map((g) => [g.rateBp, g.netCents, g.vatCents]);
const sameGroups = (a: TaxGroup[] | null, b: TaxGroup[] | null) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function sameFields(row: MirrorRow, fields: MirrorFields): boolean {
  return (
    row.number === fields.number &&
    row.issueDate === fields.issueDate &&
    row.grossCents === fields.grossCents &&
    row.vatCents === fields.vatCents &&
    row.treatment === fields.treatment &&
    sameGroups(row.taxGroups, fields.taxGroups) &&
    row.dueDate === fields.dueDate &&
    row.cancelledOn === fields.cancelledOn
  );
}

/**
 * What to write so the rows mirror the documents. `rows` are all invoices of
 * the company; `documents` are what the Books hand over (all issued
 * documents, or a window of them: a row whose document is missing is left as
 * it is, never removed).
 */
export function planMirror(rows: readonly MirrorRow[], documents: readonly BooksDocument[]): MirrorPlan {
  const plan: MirrorPlan = { writes: [], unchanged: 0, skipped: [], conflicts: [] };
  const byDocument = new Map(rows.filter((r) => r.booksDocumentId !== null).map((r) => [r.booksDocumentId as string, r]));
  const byNumber = new Map(rows.map((r) => [r.number, r]));
  // The first year of the invoices this app holds: nothing older is mirrored (the plan's section 5 leaves 1 to 27 out).
  const registerYears = rows.filter((r) => r.issueDate !== null).map((r) => Number((r.issueDate as string).slice(0, 4)));
  const firstDay = registerYears.length > 0 ? `${Math.min(...registerYears)}-01-01` : null;

  const invoices = documents.filter((d) => d.docType === 'invoice');
  const invoiceIds = new Set(invoices.map((d) => d.id));
  // The credit note of each invoice: the Books issue one per invoice, over the whole amount.
  const cancelledOn = new Map<string, string>();
  for (const note of documents.filter((d) => d.docType === 'credit_note')) {
    const invoice = invoices.find((d) => d.id === note.correctsDocumentId);
    if (!invoice) {
      // An invoice the mirror holds from an earlier pull can still be cancelled by a later one.
      const row = byDocument.get(note.correctsDocumentId as string);
      if (!row) {
        plan.conflicts.push({ number: note.number, reason: 'credit_note_without_invoice' });
        continue;
      }
      if (note.totalCents !== row.grossCents) {
        plan.conflicts.push({ number: row.number, reason: 'partial_credit_note' });
        continue;
      }
      cancelledOn.set(note.correctsDocumentId as string, note.issueDate);
      continue;
    }
    if (note.totalCents !== invoice.totalCents) {
      plan.conflicts.push({ number: invoice.number, reason: 'partial_credit_note' });
      continue;
    }
    cancelledOn.set(invoice.id, note.issueDate);
  }

  const handled = new Set<string>();
  for (const document of invoices) {
    handled.add(document.id);
    const existing = byDocument.get(document.id) ?? null;
    if (!existing && document.currencyCode !== 'EUR') {
      plan.skipped.push({ number: document.number, reason: 'not_euro' });
      continue;
    }
    const numbered = byNumber.get(document.number) ?? null;
    if (!existing && !numbered && firstDay !== null && document.issueDate < firstDay) {
      plan.skipped.push({ number: document.number, reason: 'before_register' });
      continue;
    }
    const tax = treatmentOf(document);
    if (!tax) {
      plan.conflicts.push({ number: document.number, reason: 'unsupported_tax' });
      continue;
    }
    const cancelDay = cancelledOn.get(document.id) ?? null;
    if (document.status === 'cancelled' && cancelDay === null) plan.conflicts.push({ number: document.number, reason: 'cancelled_without_credit_note' });
    const fields: MirrorFields = {
      number: document.number,
      issueDate: document.issueDate,
      grossCents: document.totalCents,
      vatCents: document.taxCents,
      treatment: tax.treatment,
      taxGroups: tax.taxGroups,
      dueDate: document.dueDate,
      // A cancellation is final: a row cancelled by an earlier pull stays cancelled.
      cancelledOn: cancelDay ?? existing?.cancelledOn ?? null,
    };
    const replacesDocumentId = document.replacesDocumentId;

    if (existing) {
      if (existing.number !== document.number && numbered && numbered.id !== existing.id) {
        plan.conflicts.push({ number: document.number, reason: 'number_taken' });
        continue;
      }
      const linkPending = replacesDocumentId !== null && existing.replacesInvoiceId === null;
      if (sameFields(existing, fields) && !linkPending) plan.unchanged += 1;
      else plan.writes.push({ documentId: document.id, rowId: existing.id, attach: false, fields, replacesDocumentId });
      continue;
    }
    if (numbered) {
      if (numbered.booksDocumentId !== null) {
        plan.conflicts.push({ number: document.number, reason: 'number_taken' });
        continue;
      }
      // A register row of the same number: the same invoice when its figures agree. A row without an issue day (an
      // invoice whose PDF shows none) agrees on the day and takes it from the document.
      const agrees =
        numbered.grossCents === fields.grossCents &&
        numbered.vatCents === fields.vatCents &&
        numbered.treatment === fields.treatment &&
        sameGroups(numbered.taxGroups, fields.taxGroups) &&
        (numbered.issueDate === null || numbered.issueDate === fields.issueDate);
      if (!agrees) {
        plan.conflicts.push({ number: document.number, reason: 'register_differs' });
        continue;
      }
      plan.writes.push({ documentId: document.id, rowId: numbered.id, attach: true, fields, replacesDocumentId });
      continue;
    }
    plan.writes.push({ documentId: document.id, rowId: null, attach: false, fields, replacesDocumentId });
  }

  // Credit notes for invoices mirrored earlier and not in this pull: the cancellation alone.
  for (const [documentId, day] of cancelledOn) {
    if (handled.has(documentId) || invoiceIds.has(documentId)) continue;
    const row = byDocument.get(documentId) as MirrorRow;
    if (row.cancelledOn !== null) {
      plan.unchanged += 1;
      continue;
    }
    plan.writes.push({
      documentId,
      rowId: row.id,
      attach: false,
      fields: {
        number: row.number,
        issueDate: row.issueDate as string,
        grossCents: row.grossCents,
        vatCents: row.vatCents,
        treatment: row.treatment as InvoiceTreatment,
        taxGroups: row.taxGroups,
        dueDate: row.dueDate,
        cancelledOn: day,
      },
      replacesDocumentId: null,
    });
  }
  return plan;
}
