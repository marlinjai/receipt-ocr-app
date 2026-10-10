import { describe, expect, it } from 'vitest';
import { forecastYear, type ForecastInput } from '../forecast';

const RULES = { previousYearLimitCents: 2_500_000, currentYearLimitCents: 10_000_000 };

function input(overrides: Partial<ForecastInput> = {}): ForecastInput {
  return {
    year: 2026,
    today: '2026-07-15',
    receivedByMonthCents: [100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 40_000],
    previousYearReceivedCents: 480_000,
    outstandingCents: 50_000,
    expectedMonthlyCents: null,
    ...overrides,
  };
}

describe('forecastYear', () => {
  it('projects a steady year from the complete months and leaves the running month out of the rate', () => {
    const f = forecastYear(input(), RULES);
    expect(f).toMatchObject({
      monthsElapsed: 7,
      receivedCents: 640_000,
      monthlyRateCents: 100_000,
      rateBasis: 'run_rate',
      basisMonths: 6,
      thinBasis: false,
      lowCents: 690_000,
      highCents: 690_000 + 5 * 100_000,
      previousYearWithinLimit: true,
    });
    expect(f.currentYear).toEqual({ state: 'not_reached' });
    expect(f.nextYear).toEqual({ state: 'not_reached' });
  });

  it('names the month the limit that decides next year is reached at the projected rate', () => {
    // 18,000.00 received by June, nothing yet in the running month of July. The projection
    // adds 3,000.00 from August on: 21,000, 24,000, then 27,000 in October passes 25,000.00.
    const f = forecastYear(input({ receivedByMonthCents: [300_000, 300_000, 300_000, 300_000, 300_000, 300_000, 0], outstandingCents: 0 }), RULES);
    expect(f.nextYear).toEqual({ state: 'possible', month: 10 });
    expect(f.currentYear).toEqual({ state: 'not_reached' });
  });

  it('says "expected" when invoices already written carry the year over the limit', () => {
    const f = forecastYear(input({ receivedByMonthCents: [400_000, 400_000, 400_000, 400_000, 400_000, 400_000, 0], outstandingCents: 200_000 }), RULES);
    // 24,000.00 received, 2,000.00 outstanding: over 25,000.00 without any new business.
    expect(f.nextYear.state).toBe('expected');
    expect(f.nextYear).toMatchObject({ monthTo: 8 });
  });

  it('says "crossed" with the month once money actually received is above the limit', () => {
    const f = forecastYear(input({ receivedByMonthCents: [900_000, 900_000, 900_000, 0, 0, 0, 0], outstandingCents: 0 }), RULES);
    expect(f.nextYear).toEqual({ state: 'crossed', month: 3 });
  });

  it('a jump in one month does not hide behind the average: the running-year limit is crossed at once', () => {
    const f = forecastYear(input({ receivedByMonthCents: [0, 0, 0, 0, 0, 10_000_001, 0], outstandingCents: 0 }), RULES);
    expect(f.currentYear).toEqual({ state: 'crossed', month: 6 });
  });

  it('uses what the owner states instead of the run rate', () => {
    const f = forecastYear(input({ expectedMonthlyCents: 500_000 }), RULES);
    expect(f).toMatchObject({ rateBasis: 'stated', monthlyRateCents: 500_000, basisMonths: 0, thinBasis: false });
    expect(f.highCents).toBe(690_000 + 5 * 500_000);
    expect(f.nextYear).toEqual({ state: 'possible', month: 11 });
  });

  it('flags a run rate that rests on fewer than three months', () => {
    const f = forecastYear(input({ today: '2026-03-10', receivedByMonthCents: [100_000, 300_000, 0] }), RULES);
    expect(f).toMatchObject({ basisMonths: 2, thinBasis: true, monthlyRateCents: 200_000 });
  });

  it('has no rate to project with in January and says so', () => {
    const f = forecastYear(input({ today: '2026-01-20', receivedByMonthCents: [50_000], outstandingCents: 0 }), RULES);
    expect(f).toMatchObject({ rateBasis: 'none', monthlyRateCents: 0, lowCents: 50_000, highCents: 50_000 });
  });

  it('a past year is all actual figures', () => {
    const f = forecastYear(input({ year: 2025, receivedByMonthCents: Array(12).fill(250_000), outstandingCents: 0 }), RULES);
    expect(f).toMatchObject({ monthsElapsed: 12, lowCents: 3_000_000, highCents: 3_000_000 });
    expect(f.nextYear).toEqual({ state: 'crossed', month: 11 });
  });

  it('in a year that is over, what was unpaid at its end is not counted as arriving in it', () => {
    // 20,000.00 received in 2025, 8,000.00 invoiced in December and paid in January.
    const f = forecastYear(input({ year: 2025, receivedByMonthCents: Array(10).fill(200_000), outstandingCents: 800_000 }), RULES);
    expect(f).toMatchObject({ receivedCents: 2_000_000, outstandingCents: 0, lowCents: 2_000_000, highCents: 2_000_000 });
    expect(f.nextYear).toEqual({ state: 'not_reached' });
  });

  it('a future year has nothing elapsed', () => {
    const f = forecastYear(input({ year: 2027, receivedByMonthCents: [], outstandingCents: 0 }), RULES);
    expect(f).toMatchObject({ monthsElapsed: 0, receivedCents: 0, rateBasis: 'none' });
  });

  it('reports whether this year stands on the previous one, and admits when it does not know', () => {
    expect(forecastYear(input({ previousYearReceivedCents: 2_500_001 }), RULES).previousYearWithinLimit).toBe(false);
    expect(forecastYear(input({ previousYearReceivedCents: 2_500_000 }), RULES).previousYearWithinLimit).toBe(true);
    expect(forecastYear(input({ previousYearReceivedCents: null }), RULES).previousYearWithinLimit).toBeNull();
  });

  it('the high figure is never below the low figure, and both never below what was received', () => {
    for (const today of ['2026-01-01', '2026-06-30', '2026-12-31']) {
      const f = forecastYear(input({ today }), RULES);
      expect(f.lowCents).toBeGreaterThanOrEqual(f.receivedCents);
      expect(f.highCents).toBeGreaterThanOrEqual(f.lowCents);
    }
  });
});
