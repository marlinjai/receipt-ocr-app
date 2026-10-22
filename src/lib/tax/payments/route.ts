import { purposeOf, type CounterpartyTreatmentAnswer } from '@/lib/spending/rules';
import type { PaymentKind } from './types';

/**
 * Which company a payment of a shared account belongs to (plan
 * docs/plans/2026-10-22-payments-across-companies.md). Pure.
 *
 * An account belongs to one company, the holder. When the holder shares it
 * with another company of the same person (the receiver), each payment goes
 * where the holder's answers say:
 *
 * - it goes to the receiver when the holder has no link on it (to a receipt or
 *   an invoice) and, judged by the holder's answers alone, its purpose is
 *   private: its counterparty answered private, the payment re-labelled
 *   private, or (a counterparty answered "Teils, teils", an account said to be
 *   private as a whole) nothing of it linked;
 * - everything else stays with the holder: business, unanswered, own
 *   account, transfers, and whatever the holder linked.
 *
 * The private-or-business rule is the spending side's `purposeOf`, never a
 * second one. Nothing is stored about the outcome: a changed answer moves the
 * payment at once, both ways.
 */

export interface RoutablePayment {
  accountId: string;
  counterpartyKey: string;
  kind: PaymentKind;
  /** True when the payment is private only because its whole account was said to be private. */
  byPrivateAccount: boolean;
  /** The HOLDER's links on it (the receiver's never count here). */
  links: readonly unknown[];
}

export function routesToReceiver(
  payment: RoutablePayment,
  holderTreatments: ReadonlyMap<string, CounterpartyTreatmentAnswer>,
  sharedAccountIds: ReadonlySet<string>,
): boolean {
  if (!sharedAccountIds.has(payment.accountId)) return false;
  // Something of it is on a business document of the holder: the whole payment stays there.
  if (payment.links.length > 0) return false;
  const treatment = payment.counterpartyKey ? holderTreatments.get(payment.counterpartyKey) : undefined;
  return purposeOf({ kind: payment.kind, linkCount: 0, byPrivateAccount: payment.byPrivateAccount }, treatment) === 'private';
}
