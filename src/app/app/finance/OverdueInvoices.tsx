'use client';

import { formatDay } from '@/lib/meals/messages';
import { formatCents } from '@/lib/tax/money';
import { REMINDER_AFTER_DAYS, type OverdueInvoice } from '@/lib/tax/overdue';

/**
 * The reminder of the open checks (decision D6 of the invoicing plan): issued
 * invoices still unpaid 14 days after their due date, as of today. A payment
 * is recorded on the "Einnahmen" tab (a day typed in) or by linking a bank
 * payment on the "Zahlungen" tab; either ends the reminder.
 */
export default function OverdueInvoices({ overdue, onOpenRevenue }: { overdue: readonly OverdueInvoice[]; onOpenRevenue: () => void }) {
  return (
    <section className="glass-panel mb-6 rounded-xl p-4 sm:p-5" aria-labelledby="overdue-invoices-heading">
      <h2 id="overdue-invoices-heading" className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
        {overdue.length === 1 ? '1 Rechnung überfällig' : `${overdue.length} Rechnungen überfällig`}
      </h2>
      <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
        Stand heute, aus allen Jahren: mehr als {REMINDER_AFTER_DAYS} Tage nach Fälligkeit (Rechnungsdatum plus 14 Tage Zahlungsziel) noch nicht ganz bezahlt.
        Ist das Geld schon da, die Zahlung unter „Zahlungen“ zuordnen oder unter „Einnahmen“ eintragen; sonst ist eine Erinnerung an den Kunden fällig.
      </p>
      <ul className="mt-3 divide-y" style={{ borderColor: 'var(--border)' }}>
        {overdue.map((invoice) => (
          <li key={invoice.invoiceId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm">
            <span style={{ color: 'var(--foreground)' }}>
              Rechnung {invoice.number} vom {formatDay(invoice.issueDate)}
            </span>
            <span className="tabular-nums" style={{ color: 'var(--muted)' }}>
              fällig {formatDay(invoice.dueDate)}, {invoice.daysPastDue} Tage überfällig, offen {formatCents(invoice.openCents)} €
            </span>
          </li>
        ))}
      </ul>
      <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm mt-3" onClick={onOpenRevenue}>
        Zu den Einnahmen
      </button>
    </section>
  );
}
