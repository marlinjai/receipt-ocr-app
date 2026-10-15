import { describe, expect, it } from 'vitest';
import { defaultDueDate, overdueInvoices, type OverdueInput } from '../overdue';

const invoice = (o: Partial<OverdueInput> & { id: string }): OverdueInput => ({ number: o.id, issueDate: '2026-09-01', grossCents: 100_000, payments: [], ...o });

describe('defaultDueDate', () => {
  it('adds the 14-day term, across a month and a year end', () => {
    expect(defaultDueDate('2026-09-01')).toBe('2026-09-15');
    expect(defaultDueDate('2026-12-25')).toBe('2027-01-08');
  });
});

describe('overdueInvoices', () => {
  // Issued 2026-09-01: due 2026-09-15, listed from 2026-09-29.
  it('lists an unpaid invoice from 14 days after its due date on, not a day earlier', () => {
    expect(overdueInvoices([invoice({ id: 'a' })], '2026-09-28')).toEqual([]);
    expect(overdueInvoices([invoice({ id: 'a' })], '2026-09-29')).toEqual([
      { invoiceId: 'a', number: 'a', issueDate: '2026-09-01', dueDate: '2026-09-15', openCents: 100_000, daysPastDue: 14 },
    ]);
  });

  it('never lists an invoice paid in full, by one payment or several, or overpaid', () => {
    const today = '2026-12-01';
    expect(overdueInvoices([invoice({ id: 'a', payments: [{ date: '2026-09-10', cents: 100_000 }] })], today)).toEqual([]);
    expect(
      overdueInvoices([invoice({ id: 'a', payments: [{ date: '2026-09-10', cents: 40_000 }, { date: '2026-10-10', cents: 60_000 }] })], today),
    ).toEqual([]);
    expect(overdueInvoices([invoice({ id: 'a', payments: [{ date: '2026-09-10', cents: 120_000 }] })], today)).toEqual([]);
  });

  it('never lists a remainder that was booked out as a fee the client kept', () => {
    const fee = invoice({ id: 'a', grossCents: 284_000, payments: [{ date: '2026-09-10', cents: 283_000 }], writtenOffCents: 1_000 });
    expect(overdueInvoices([fee], '2026-12-01')).toEqual([]);
    expect(overdueInvoices([{ ...fee, writtenOffCents: 500 }], '2026-12-01')[0].openCents).toBe(500);
  });

  it('lists what is still open after a part payment', () => {
    const [entry] = overdueInvoices([invoice({ id: 'a', payments: [{ date: '2026-09-10', cents: 30_000 }] })], '2026-10-15');
    expect(entry.openCents).toBe(70_000);
    expect(entry.daysPastDue).toBe(30);
  });

  it('counts a linked payment whatever its day: it ends the reminder', () => {
    expect(overdueInvoices([invoice({ id: 'a', payments: [{ date: '2026-10-20', cents: 100_000 }] })], '2026-10-15')).toEqual([]);
  });

  it('ignores a stored day that does not exist instead of rolling it over', () => {
    expect(overdueInvoices([invoice({ id: 'a', issueDate: '2026-02-30' })], '2026-12-01')).toEqual([]);
    expect(() => overdueInvoices([], '2026-02-30')).toThrow();
  });

  it('skips an invoice without a date or without an amount', () => {
    expect(overdueInvoices([invoice({ id: 'a', issueDate: null }), invoice({ id: 'b', grossCents: 0 })], '2027-01-01')).toEqual([]);
  });

  it('uses a stated due date over the default term', () => {
    expect(overdueInvoices([invoice({ id: 'a', dueDate: '2026-10-31' })], '2026-11-13')).toEqual([]);
    expect(overdueInvoices([invoice({ id: 'a', dueDate: '2026-10-31' })], '2026-11-14')[0].daysPastDue).toBe(14);
  });

  it('sorts by due date, then by invoice number as a number', () => {
    const list = overdueInvoices(
      [invoice({ id: 'x', number: '61', issueDate: '2026-09-20' }), invoice({ id: 'y', number: '9', issueDate: '2026-08-01' }), invoice({ id: 'z', number: '10', issueDate: '2026-08-01' })],
      '2026-12-01',
    );
    expect(list.map((i) => i.number)).toEqual(['9', '10', '61']);
  });

  it('refuses a today that is not an ISO day', () => {
    expect(() => overdueInvoices([], '15.10.2026')).toThrow();
  });
});
