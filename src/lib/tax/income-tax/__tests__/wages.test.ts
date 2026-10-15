import { describe, expect, it } from 'vitest';
import { aggregateWages, churchMonthsFromPaySlips, zeroFigures, type WageEntry, type WageFigures } from '../wages';

let n = 0;
const slip = (month: number, figures: Partial<WageFigures> = {}, extra: Partial<WageEntry> = {}): WageEntry => ({
  id: `w-${++n}`,
  employer: 'Arbeitgeber',
  month,
  healthWithSickPay: true,
  churchLiable: null,
  ...zeroFigures(),
  grossCents: 400_000,
  wageTaxCents: 60_000,
  healthEmployeeCents: 30_000,
  ...figures,
  ...extra,
});

describe('aggregateWages', () => {
  it('is null without any entry', () => {
    expect(aggregateWages([], true)).toBeNull();
  });

  it('adds up pay slips of a running year', () => {
    const w = aggregateWages([slip(1), slip(2), slip(3)], false)!;
    expect(w.total.grossCents).toBe(1_200_000);
    expect(w.employers[0]).toMatchObject({ basis: 'pay_slips', months: [1, 2, 3], gaps: [], projectedMonths: [] });
    expect(w.projected).toBe(false);
  });

  it('projects the last pay slip to December, never the months before the first', () => {
    const w = aggregateWages([slip(2), slip(3, { grossCents: 500_000 })], true)!;
    // February 4,000 + March 5,000 + nine months at 5,000.
    expect(w.total.grossCents).toBe(400_000 + 500_000 * 10);
    expect(w.employers[0].projectedMonths).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(w.projected).toBe(true);
    expect(w.healthWithSickPayCents).toBe(30_000 * 11);
  });

  it('names a month missing between two pay slips', () => {
    expect(aggregateWages([slip(1), slip(3)], false)!.employers[0].gaps).toEqual([2]);
  });

  it('uses the annual statement of an employer over its pay slips', () => {
    const w = aggregateWages([slip(1), slip(2), slip(0, { grossCents: 5_000_000 })], true)!;
    expect(w.total.grossCents).toBe(5_000_000);
    expect(w.employers[0]).toMatchObject({ basis: 'annual_statement', ignoredPaySlips: 2, projectedMonths: [] });
  });

  it('adds two employers', () => {
    const w = aggregateWages([slip(0, { grossCents: 100 }), slip(0, { grossCents: 200 }, { employer: 'Zweiter' })], false)!;
    expect(w.employers.map((e) => e.employer)).toEqual(['Arbeitgeber', 'Zweiter']);
    expect(w.total.grossCents).toBe(300);
  });

  it('keeps contributions without sick pay out of the reduced part', () => {
    const w = aggregateWages([slip(1, {}, { healthWithSickPay: false })], false)!;
    expect(w.healthWithSickPayCents).toBe(0);
  });
});

describe('churchMonthsFromPaySlips', () => {
  it('reads liability from church tax withheld, or from the stated flag', () => {
    const months = churchMonthsFromPaySlips(
      [slip(1, { churchTaxCents: 5_000 }), slip(2, { churchTaxCents: 5_000 }), slip(3, {}, { churchLiable: false }), slip(4, {}, { churchLiable: true })],
      false,
    )!;
    expect(months.slice(0, 5)).toEqual([true, true, false, true, false]);
  });

  it('carries the last slip into projected months', () => {
    const months = churchMonthsFromPaySlips([slip(9, { churchTaxCents: 1 })], true)!;
    expect(months.filter(Boolean).length).toBe(4);
  });

  it('is null without pay slips (an annual statement does not say which months)', () => {
    expect(churchMonthsFromPaySlips([slip(0)], true)).toBeNull();
  });
});
