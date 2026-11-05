import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { parseBooksDocuments, planMirror, type MirrorConflictReason, type MirrorRow, type MirrorSkipReason } from './books-mirror';
import { parseTaxGroups } from './revenue-input';
import type { TaxContext } from './service';

/**
 * Writes the mirror of the Books documents (see `books-mirror.ts` for the
 * rules) into this app's invoices, in one transaction per company, so a pull
 * either lands whole or not at all. Two pulls of one company never interleave
 * (a transaction lock per company), and a pull of the same documents again
 * changes nothing.
 */

export interface MirrorReport {
  /** New invoices from the Books. */
  created: number;
  /** Register rows that turned out to be a Books document (same number, same figures). */
  attached: number;
  /** Mirror rows whose document changed (a cancellation, mostly). */
  updated: number;
  unchanged: number;
  /** Payments (bank links and typed-in payment days) moved from a corrected invoice to its replacement. */
  paymentsMoved: number;
  skipped: Array<{ number: string; reason: MirrorSkipReason }>;
  conflicts: Array<{ number: string; reason: MirrorConflictReason | 'replaced_invoice_unknown' }>;
}

export async function applyBooksDocuments(db: PrismaClient, ctx: TaxContext, raw: unknown): Promise<MirrorReport> {
  const { documents, refused } = parseBooksDocuments(raw);
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`books-mirror:${ctx.workspaceId}`}))`;
      const stored = await tx.taxIssuedInvoice.findMany({ where: { authWorkspaceId: ctx.workspaceId } });
      const rows: MirrorRow[] = stored.map((s) => ({
        id: s.id,
        number: s.number,
        source: s.source === 'books' ? 'books' : 'register',
        booksDocumentId: s.booksDocumentId,
        issueDate: s.issueDate,
        grossCents: s.grossCents,
        vatCents: s.vatCents,
        treatment: s.treatment,
        taxGroups: s.taxGroups === null ? null : parseTaxGroups(s.taxGroups),
        dueDate: s.dueDate,
        cancelledOn: s.cancelledOn,
        replacesInvoiceId: s.replacesInvoiceId,
      }));
      const plan = planMirror(rows, documents);
      const report: MirrorReport = {
        created: 0,
        attached: 0,
        updated: 0,
        unchanged: plan.unchanged,
        paymentsMoved: 0,
        skipped: plan.skipped,
        conflicts: [...refused, ...plan.conflicts],
      };

      const rowOfDocument = new Map(rows.filter((r) => r.booksDocumentId !== null).map((r) => [r.booksDocumentId as string, r]));
      const writtenRowOf = new Map<string, string>();
      for (const write of plan.writes) {
        const data = {
          number: write.fields.number,
          issueDate: write.fields.issueDate,
          grossCents: write.fields.grossCents,
          vatCents: write.fields.vatCents,
          treatment: write.fields.treatment,
          // Prisma needs DbNull, not null, to clear a JSON column.
          taxGroups: write.fields.taxGroups === null ? Prisma.DbNull : (write.fields.taxGroups as unknown as Prisma.InputJsonValue),
          dueDate: write.fields.dueDate,
          cancelledOn: write.fields.cancelledOn,
          source: 'books',
          booksDocumentId: write.documentId,
        };
        if (write.rowId === null) {
          const created = await tx.taxIssuedInvoice.create({ data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, ...data } });
          writtenRowOf.set(write.documentId, created.id);
          report.created += 1;
        } else {
          await tx.taxIssuedInvoice.update({ where: { id: write.rowId }, data });
          writtenRowOf.set(write.documentId, write.rowId);
          if (write.attach) report.attached += 1;
          else report.updated += 1;
        }
      }

      // A corrected invoice takes over the payments of the invoice it replaces, once, when the link is first made.
      for (const write of plan.writes) {
        if (write.replacesDocumentId === null) continue;
        const rowId = writtenRowOf.get(write.documentId) as string;
        if (rowOfDocument.get(write.documentId)?.replacesInvoiceId) continue;
        const replacedId = writtenRowOf.get(write.replacesDocumentId) ?? rowOfDocument.get(write.replacesDocumentId)?.id ?? null;
        if (replacedId === null) {
          report.conflicts.push({ number: write.fields.number, reason: 'replaced_invoice_unknown' });
          continue;
        }
        // Both invoices locked as a link to a bank payment locks its invoice, so a link made at this moment waits.
        await tx.$queryRaw`SELECT id FROM tax_issued_invoices WHERE id IN (${replacedId}, ${rowId}) AND auth_workspace_id = ${ctx.workspaceId} ORDER BY id FOR UPDATE`;
        const links = await tx.taxPaymentLink.updateMany({ where: { invoiceId: replacedId }, data: { invoiceId: rowId } });
        const typed = await tx.taxInvoicePayment.updateMany({ where: { invoiceId: replacedId, authWorkspaceId: ctx.workspaceId }, data: { invoiceId: rowId } });
        await tx.taxIssuedInvoice.update({ where: { id: rowId }, data: { replacesInvoiceId: replacedId } });
        report.paymentsMoved += links.count + typed.count;
      }
      return report;
    },
    { timeout: 30_000 },
  );
}
