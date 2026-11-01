import { describe, expect, it } from 'vitest';
import { RECEIPT_NOT_FOUND } from '@/lib/spending/loop';
import { CHECKS_PAGE, answerTakenBack, answeredNoReceipt, mailSetAside, receiptLinked, checkYears, chooseChecks, splitAnswered, type OpenCheckItem } from './open-checks';
import type { PaymentCheck } from '@/lib/spending/loop-service';

const check = (paymentId: string, bookingDay: string, proposed = false): OpenCheckItem => ({
  paymentId,
  bookingDay,
  state: proposed ? { state: 'proposed', candidates: [] } : { state: 'missing' },
});
const many = Array.from({ length: 70 }, (_, i) => check(`p${i}`, i < 40 ? '2026-05-01' : '2025-05-01', i % 2 === 0));
const everything = { year: null, onlyProposed: false, limit: CHECKS_PAGE };

describe('the open payments list', () => {
  it('counts the years, newest first', () => {
    expect(checkYears(many)).toEqual([
      { year: '2026', count: 40 },
      { year: '2025', count: 30 },
    ]);
  });

  it('shows one page at a time and says how many match', () => {
    const { shown, matching } = chooseChecks(many, everything, null);
    expect(shown).toHaveLength(CHECKS_PAGE);
    expect(matching).toBe(70);
    expect(chooseChecks(many, { ...everything, limit: 60 }, null).shown).toHaveLength(60);
  });

  it('narrows to a year and to payments with a proposal', () => {
    expect(chooseChecks(many, { ...everything, year: '2025' }, null).matching).toBe(30);
    expect(chooseChecks(many, { ...everything, year: '2025', onlyProposed: true }, null).matching).toBe(15);
  });

  it('keeps the payment a notification points at, whatever the choice', () => {
    expect(chooseChecks(many, { ...everything, year: '2026' }, 'p69').shown[0].paymentId).toBe('p69');
    const onPage = chooseChecks(many, everything, 'p3').shown;
    expect(onPage.filter((c) => c.paymentId === 'p3')).toHaveLength(1);
    expect(onPage).toHaveLength(CHECKS_PAGE);
  });

  it('shows nothing for a choice nothing matches, and ignores a payment that is settled', () => {
    expect(chooseChecks(many, { ...everything, year: '2019' }, 'gone')).toEqual({ shown: [], matching: 0 });
  });
});

describe('the answered payments', () => {
  it('sets apart those whose receipt could not be found', () => {
    const lost = { state: { state: 'no_receipt' as const, reason: RECEIPT_NOT_FOUND } };
    const said = { state: { state: 'no_receipt' as const, reason: 'Automat' } };
    expect(splitAnswered([lost, said])).toEqual({ lost: [lost], answered: [said] });
  });
});

describe('what an action shows until the server has answered', () => {
  const check = (state: PaymentCheck['state']): PaymentCheck => ({ paymentId: 'p', bookingDay: '2026-05-01', cents: 100, counterparty: 'X', reference: '', state });
  const mail = (id: string) => ({ id, fileName: `${id}.pdf`, receivedDay: '2026-05-01', subject: '', sender: '' });

  it('an answer carries the reason as the server will keep it', () => {
    expect(answeredNoReceipt(' Automat ')(check({ state: 'missing' }))?.state).toEqual({ state: 'no_receipt', reason: 'Automat' });
  });

  it('a link settles the payment', () => {
    expect(receiptLinked(check({ state: 'missing' }))?.state).toEqual({ state: 'has_receipt' });
  });

  it('a taken back answer opens the payment, unless it stands in another company by now', () => {
    expect(answerTakenBack(check({ state: 'no_receipt', reason: 'x' }))?.state).toEqual({ state: 'missing' });
    expect(answerTakenBack(check({ state: 'no_receipt', reason: 'x', movedAway: true }))).toBeNull();
  });

  it('a mail set aside leaves the others, and a payment that holds none is left as it is', () => {
    expect(mailSetAside('a')(check({ state: 'in_mailbox', mails: [mail('a'), mail('b')] }))?.state).toEqual({ state: 'in_mailbox', mails: [mail('b')] });
    expect(mailSetAside('a')(check({ state: 'in_mailbox', mails: [mail('a')] }))?.state).toEqual({ state: 'missing' });
    const other = check({ state: 'missing' });
    expect(mailSetAside('a')(other)).toBe(other);
  });
});
