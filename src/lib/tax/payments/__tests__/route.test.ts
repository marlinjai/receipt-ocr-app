import { describe, expect, it } from 'vitest';
import { routesToReceiver, type RoutablePayment } from '../route';
import type { CounterpartyTreatmentAnswer } from '@/lib/spending/rules';

/** Which company a payment of a shared account belongs to: the one rule, on its own. */

const SHARED = new Set(['acc-shared']);
const pay = (o: Partial<RoutablePayment> = {}): RoutablePayment => ({ accountId: 'acc-shared', counterpartyKey: 'laden', kind: 'spend', byPrivateAccount: false, links: [], ...o });
const answers = (treatment?: CounterpartyTreatmentAnswer) => new Map<string, CounterpartyTreatmentAnswer>(treatment ? [['laden', treatment]] : []);

describe('routesToReceiver', () => {
  it('sends a payment whose counterparty the holder answered private', () => {
    expect(routesToReceiver(pay(), answers('private'), SHARED)).toBe(true);
  });

  it('keeps business, unanswered and own-account payments with the holder', () => {
    expect(routesToReceiver(pay(), answers('business'), SHARED)).toBe(false);
    expect(routesToReceiver(pay(), answers(), SHARED)).toBe(false);
    expect(routesToReceiver(pay({ kind: 'own_transfer' }), answers('own_account'), SHARED)).toBe(false);
  });

  it('sends one payment re-labelled private, whatever its counterparty is unanswered', () => {
    expect(routesToReceiver(pay({ kind: 'private' }), answers(), SHARED)).toBe(true);
  });

  it('sends an unlinked payment of a mixed counterparty or of a private account, and keeps it once the holder linked it', () => {
    expect(routesToReceiver(pay(), answers('mixed'), SHARED)).toBe(true);
    expect(routesToReceiver(pay({ kind: 'private', byPrivateAccount: true }), answers(), SHARED)).toBe(true);
    expect(routesToReceiver(pay({ links: [{}] }), answers('mixed'), SHARED)).toBe(false);
    expect(routesToReceiver(pay({ kind: 'private', byPrivateAccount: true, links: [{}] }), answers(), SHARED)).toBe(false);
  });

  it('keeps a private payment the holder linked to a document, and never routes an account that is not shared', () => {
    expect(routesToReceiver(pay({ links: [{}] }), answers('private'), SHARED)).toBe(false);
    expect(routesToReceiver(pay({ accountId: 'acc-other' }), answers('private'), SHARED)).toBe(false);
  });

  it('sends income, money back and a fee the holder answered private or mixed, but never a transfer between own accounts', () => {
    for (const kind of ['income', 'refund', 'fee'] as const) {
      expect(routesToReceiver(pay({ kind }), answers('private'), SHARED)).toBe(true);
      expect(routesToReceiver(pay({ kind }), answers('mixed'), SHARED)).toBe(true);
      expect(routesToReceiver(pay({ kind }), answers(), SHARED)).toBe(false);
    }
    expect(routesToReceiver(pay({ kind: 'own_transfer' }), answers('private'), SHARED)).toBe(false);
    expect(routesToReceiver(pay({ kind: 'own_transfer' }), answers('mixed'), SHARED)).toBe(false);
  });

  it('keeps a payment without a name with the holder unless it was re-labelled private', () => {
    expect(routesToReceiver(pay({ counterpartyKey: '' }), answers('private'), SHARED)).toBe(false);
    expect(routesToReceiver(pay({ counterpartyKey: '', kind: 'private' }), answers(), SHARED)).toBe(true);
  });
});
