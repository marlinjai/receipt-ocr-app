import { formatDay } from '@/lib/meals/messages';
import { spendingPath } from '@/lib/spending/paths';
import type { PaymentAwaitingReceipt } from '@/lib/spending/loop-service';
import { formatCents } from '@/lib/tax/money';
import type { UploadLink, UploadLinkRefusal } from '@/lib/upload/pipeline';

/**
 * The upload page opened for one payment (a check card's "Beleg fotografieren
 * oder hochladen"): what the page knows about it and what became of the link.
 * Pure, so the whole walk (waiting, linked, refused, discarded, gone) is
 * testable without a page.
 */
export type UploadFor =
  /** The payment still waits: the next saved receipt is linked to it. */
  | { state: 'open'; workspaceId: string; payment: PaymentAwaitingReceipt }
  /** The address named a payment that does not wait here (it got a receipt, or belongs to another company). */
  | { state: 'gone'; workspaceId: string };

export type UploadForProgress =
  | { step: 'waiting' }
  /**
   * `rowId` is the receipt linked: discarding it opens the payment again.
   * `unlinked` counts the further files of the same batch (another page of a
   * split PDF, a second photo) that were saved but could not be linked too.
   */
  | { step: 'linked'; rowId: string; unlinked: number }
  | { step: 'refused'; reason: UploadLinkRefusal };

/**
 * The payment a file chosen NOW should be linked to: only while the page waits
 * for its receipt. The file keeps it from then on (a queued photo too), so a
 * later change of the page never moves it to another payment.
 */
export function paymentToLink(uploadFor: UploadFor | null, progress: UploadForProgress): string | undefined {
  // A link that failed for no reason of the payment's may be tried again with the next file.
  const open = progress.step === 'waiting' || (progress.step === 'refused' && progress.reason === 'failed');
  return uploadFor?.state === 'open' && open ? uploadFor.payment.id : undefined;
}

/**
 * What one upload's answer moves the page to. An answer about another payment
 * (a photo queued for it earlier) changes nothing. A link wins over a refusal
 * whichever arrives last: two files sent for the same payment at once, the
 * second refused because the first linked, still leave the payment linked.
 */
export function afterSave(uploadFor: UploadFor | null, progress: UploadForProgress, link: UploadLink | null | undefined): UploadForProgress {
  if (uploadFor?.state !== 'open' || !link || link.paymentId !== uploadFor.payment.id) return progress;
  if (link.linked) {
    if (progress.step !== 'linked') return { step: 'linked', rowId: link.rowId, unlinked: 0 };
    // The same receipt answered twice (a resend) is one link; another receipt linked as well shares the payment.
    return progress;
  }
  if (progress.step === 'linked') return { ...progress, unlinked: progress.unlinked + 1 };
  return progress.step === 'waiting' ? { step: 'refused', reason: link.reason } : progress;
}

/** A receipt was discarded on this page: when it is the one linked, its links went with it and the payment waits again. */
export function afterDiscard(progress: UploadForProgress, rowId: string): UploadForProgress {
  return progress.step === 'linked' && progress.rowId === rowId ? { step: 'waiting' } : progress;
}

/** "NAVIT, 59,85 € vom 01.11.2026": the payment as the card shows it. */
export function paymentLine(payment: PaymentAwaitingReceipt): string {
  return `${payment.counterparty || 'Zahlung ohne Namen'}, ${payment.estimated ? 'ca. ' : ''}${formatCents(payment.amountCents)} € vom ${formatDay(payment.bookingDay)}`;
}

const REFUSALS: Record<Extract<UploadForProgress, { step: 'refused' }>['reason'], string> = {
  already_has_receipt: 'die Zahlung hat inzwischen einen anderen Beleg',
  receipt_already_paid: 'der Beleg ist schon einer anderen Zahlung zugeordnet',
  receipt_not_found: 'der Beleg ist nicht mehr da',
  payment_not_open: 'die Zahlung wartet nicht mehr auf einen Beleg',
  payment_not_found: 'die Zahlung gibt es in dieser Firma nicht mehr',
  forbidden: 'du darfst in dieser Firma keine Belege zuordnen',
  failed: 'das Zuordnen ist fehlgeschlagen',
};

/** Why the saved receipt is not linked, in the person's words. */
export function refusalText(reason: Extract<UploadForProgress, { step: 'refused' }>['reason']): string {
  return REFUSALS[reason];
}

/** "1 weiterer Beleg wurde gespeichert, aber keiner Zahlung zugeordnet." */
export function unlinkedText(count: number): string {
  return count === 1
    ? '1 weiterer Beleg dieses Uploads wurde gespeichert, aber keiner Zahlung zugeordnet.'
    : `${count} weitere Belege dieses Uploads wurden gespeichert, aber keiner Zahlung zugeordnet.`;
}

/** Back to the open receipts of the company the payment waits in. */
export function checksHref(uploadFor: UploadFor): string {
  return spendingPath(uploadFor.workspaceId, { ansicht: 'belege' });
}
