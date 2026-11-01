import { describe, expect, it } from 'vitest';
import { CHECKS_PAGE, checkYears, chooseChecks, type OpenCheckItem } from './open-checks';

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
