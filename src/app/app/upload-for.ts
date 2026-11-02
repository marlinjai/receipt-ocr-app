import { formatDay } from '@/lib/meals/messages';
import { spendingPath } from '@/lib/spending/paths';
import type { PaymentAwaitingReceipt } from '@/lib/spending/loop-service';
import { formatCents } from '@/lib/tax/money';
import type { UploadLink } from './actions';

/**
 * The upload page opened for one payment (a check card's "Beleg fotografieren
 * oder hochladen"): what the page knows about it and what became of the link.
 * Pure, so the whole walk (waiting, linked, refused, gone) is testable without
 * a page.
 */
export type UploadFor =
  /** The payment still waits: the next saved receipt is linked to it. */
  | { state: 'open'; workspaceId: string; payment: PaymentAwaitingReceipt }
  /** The address named a payment that does not wait here (it got a receipt, or belongs to another company). */
  | { state: 'gone'; workspaceId: string };

export type UploadForProgress =
  | { step: 'waiting' }
  | { step: 'linked' }
  | { step: 'refused'; reason: Extract<UploadLink, { linked: false }>['reason'] };

/** The payment an upload should still be linked to: only while the page waits for the first saved receipt. */
export function paymentToLink(uploadFor: UploadFor | null, progress: UploadForProgress): string | undefined {
  return uploadFor?.state === 'open' && progress.step === 'waiting' ? uploadFor.payment.id : undefined;
}

/** What one save's answer moves the page to. A save that did not ask (or answered for another payment) changes nothing. */
export function afterSave(uploadFor: UploadFor | null, progress: UploadForProgress, link: UploadLink | null | undefined): UploadForProgress {
  if (uploadFor?.state !== 'open' || progress.step !== 'waiting' || !link || link.paymentId !== uploadFor.payment.id) return progress;
  return link.linked ? { step: 'linked' } : { step: 'refused', reason: link.reason };
}

/** "NAVIT, 59,85 € vom 01.11.2026": the payment as the card shows it. */
export function paymentLine(payment: PaymentAwaitingReceipt): string {
  return `${payment.counterparty || 'Zahlung ohne Namen'}, ${payment.estimated ? 'ca. ' : ''}${formatCents(payment.amountCents)} € vom ${formatDay(payment.bookingDay)}`;
}

const REFUSALS: Record<Extract<UploadForProgress, { step: 'refused' }>['reason'], string> = {
  already_has_receipt: 'die Zahlung hat inzwischen einen anderen Beleg',
  payment_not_open: 'die Zahlung wartet nicht mehr auf einen Beleg',
  payment_not_found: 'die Zahlung gibt es in dieser Firma nicht mehr',
  forbidden: 'du darfst in dieser Firma keine Belege zuordnen',
  failed: 'das Zuordnen ist fehlgeschlagen',
};

/** Why the saved receipt is not linked, in the person's words. */
export function refusalText(reason: Extract<UploadForProgress, { step: 'refused' }>['reason']): string {
  return REFUSALS[reason];
}

/** Back to the open receipts of the company the payment waits in. */
export function checksHref(uploadFor: UploadFor): string {
  return spendingPath(uploadFor.workspaceId, { ansicht: 'belege' });
}
