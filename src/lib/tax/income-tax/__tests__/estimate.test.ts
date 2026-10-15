import { describe, expect, it } from 'vitest';
import { estimateIncomeTax, type EstimateInput, type IncomeTaxEstimate } from '../estimate';
import type { ReturnItemFact, ReturnItemKey } from '../return-items';
import { aggregateWages, zeroFigures, type WageEntry, type WageFigures } from '../wages';

let nextId = 0;
const item = (key: ReturnItemKey, fields: Partial<ReturnItemFact>): ReturnItemFact => ({
  id: `item-${++nextId}`,
  key,
  amountCents: null,
  days: null,
  distanceKm: null,
  note: null,
  ...fields,
});

const entry = (month: number, figures: Partial<WageFigures>, extra: Partial<WageEntry> = {}): WageEntry => ({
  id: `wage-${++nextId}`,
  employer: 'Arbeitgeber',
  month,
  healthWithSickPay: true,
  churchLiable: null,
  ...zeroFigures(),
  ...figures,
  ...extra,
});

const months = (from: number, to: number) => Array.from({ length: 12 }, (_, i) => i + 1 >= from && i + 1 <= to);
const figure = (e: IncomeTaxEstimate, id: string) => e.sections.flatMap((s) => s.figures).find((f) => f.id === id)!;

/**
 * The 2025 return of the reference user, built from aggregate figures only
 * (no names, no tax numbers): the annual wage statement of a job from
 * February with tax class 1, a business loss, home office days, four trips to
 * the university, study costs, student loan interest as own vocational
 * training, self-paid health and care contributions from before the job, a
 * contribution refund, and a church exit in November in Berlin.
 *
 * The tax office's provisional calculation of the saved draft (2026-10-11)
 * reads: taxable income 28,287; income tax 3,822 against 8,072 withheld,
 * refund 4,250.00; church tax 315.31 (11 months) against 662.07 withheld,
 * refund 346.76; together 4,596.76.
 */
function case2025(overrides: Partial<EstimateInput> = {}): EstimateInput {
  return {
    year: 2025,
    businessProfitCents: -959_483,
    wages: aggregateWages(
      [
        entry(0, {
          grossCents: 5_296_950,
          wageTaxCents: 807_176,
          solidarityCents: 0,
          churchTaxCents: 66_207,
          pensionEmployeeCents: 507_743,
          pensionEmployerCents: 507_743,
          healthEmployeeCents: 506_957,
          careEmployeeCents: 131_031,
          unemploymentEmployeeCents: 70_975,
        }),
      ],
      false,
    ),
    // The draft entered the six study cost rows in whole euros: 1,369.
    employmentReceiptsCents: 136_900,
    returnItems: [
      item('employment.home_office_days', { days: 116 }),
      item('employment.commute', { days: 4, distanceKm: 20, note: 'Hochschule' }),
      item('special.vocational_training', { amountCents: 77_766, note: 'Zinsen Studienkredit' }),
      // The insurer's certificate: 372 self-paid health, 71 care, 143 refunded.
      // The calculation reduced only the wage statement's contribution by 4
      // percent (202 = 4 % of 5,070), so the self-paid health contribution is
      // entered here as one without sick pay, as the draft carried it.
      item('insurance.health_self_paid', { amountCents: 37_200 }),
      item('insurance.care_self_paid', { amountCents: 7_100 }),
      item('insurance.refunded', { amountCents: 14_300 }),
    ],
    churchMonths: months(1, 11),
    churchMonthsBasis: 'stated',
    federalState: 'BE',
    ...overrides,
  };
}

describe('estimateIncomeTax: the 2025 case against the tax office', () => {
  const e = estimateIncomeTax(case2025());

  it('reproduces every intermediate figure of the provisional calculation', () => {
    expect(figure(e, 'business.result').cents).toBe(-959_500);
    expect(figure(e, 'employment.gross').cents).toBe(5_296_900);
    expect(figure(e, 'employment.commute').cents).toBe(2_400);
    expect(figure(e, 'employment.home_office').cents).toBe(69_600);
    expect(figure(e, 'employment.deducted').cents).toBe(-208_900);
    expect(figure(e, 'employment.income').cents).toBe(5_088_000);
    expect(figure(e, 'income.total').cents).toBe(4_128_500);
    expect(figure(e, 'insurance.pension').cents).toBe(507_800);
    expect(figure(e, 'insurance.basic').cents).toBe(647_900);
    expect(figure(e, 'insurance.other').cents).toBe(0);
    expect(figure(e, 'insurance.total').cents).toBe(-1_155_700);
    expect(figure(e, 'special.church').cents).toBe(66_300);
    expect(figure(e, 'special.training').cents).toBe(77_800);
    expect(figure(e, 'special.total').cents).toBe(-144_100);
    expect(e.taxableIncomeEuros).toBe(28_287);
  });

  it('reproduces the tax and the church tax for eleven months exactly', () => {
    expect(e.scope).toBe('full');
    expect(e.missing).toEqual([]);
    expect(e.incomeTax.assessedCents).toBe(382_200);
    expect(e.solidarity.assessedCents).toBe(0);
    expect(e.churchTax.assessedCents).toBe(31_531);
    expect(e.churchTax.balanceCents).toBe(-34_676);
  });

  it('differs from the stated refund by 24 cents, and only because the provisional calculation shows wage tax in whole euros', () => {
    // The provisional calculation credits 8,072.00; the wage statement says
    // 8,071.76, and the assessment credits what was withheld, to the cent.
    expect(e.incomeTax.withheldCents).toBe(807_176);
    expect(e.incomeTax.balanceCents).toBe(-424_976);
    expect(e.totalBalanceCents).toBe(-459_652);
    const elsterTotal = -459_676;
    expect(Math.abs((e.totalBalanceCents as number) - elsterTotal)).toBeLessThanOrEqual(100);
  });

  it('stays within one euro of tax when the study costs come in cents from the app (1,369.82 instead of 1,369)', () => {
    const fromApp = estimateIncomeTax(case2025({ employmentReceiptsCents: 136_982 }));
    // One euro more work-related costs (rounded up in the taxpayer's favour).
    expect(figure(fromApp, 'employment.receipts').cents).toBe(137_000);
    expect(Math.abs((fromApp.incomeTax.assessedCents as number) - 382_200)).toBeLessThanOrEqual(100);
  });

  it('names what the business changed in the tax', () => {
    // Without the loss the tax would be much higher: the loss lowers the total by thousands.
    expect(e.businessEffectCents).not.toBeNull();
    expect(e.businessEffectCents as number).toBeLessThan(-200_000);
  });

  it('shows every figure with its inputs, and every rule figure with its source', () => {
    expect(figure(e, 'tax.income').source?.citation).toMatch(/§ 32a/);
    expect(figure(e, 'employment.commute').inputs[0].text).toBe('4 Tage × 20 km');
    expect(figure(e, 'special.church').inputs.map((i) => i.cents)).toEqual([66_207, 0, 0]);
  });
});

describe('estimateIncomeTax: incomplete data (the unhappy paths)', () => {
  it('without wage data shows the business only and asks for one pay slip', () => {
    const e = estimateIncomeTax(case2025({ wages: null }));
    expect(e.scope).toBe('business_only');
    expect(e.missing.map((m) => m.code)).toContain('wages');
    expect(e.missing.find((m) => m.code === 'wages')!.text).toMatch(/eine Lohnabrechnung/);
    expect(e.sections.some((s) => s.id === 'employment')).toBe(false);
    expect(e.assumptions.join(' ')).toMatch(/Werbungskosten der Anlage N zählen erst mit Lohndaten/);
    // A loss and no wages: nothing taxable, nothing to pay.
    expect(e.incomeTax.assessedCents).toBe(0);
  });

  it('without a business result estimates the wages and says the business is missing', () => {
    const e = estimateIncomeTax(case2025({ businessProfitCents: null }));
    expect(e.scope).toBe('without_business');
    expect(e.missing.map((m) => m.code)).toEqual(['business_result']);
    expect(e.businessEffectCents).toBeNull();
    expect(e.incomeTax.assessedCents as number).toBeGreaterThan(382_200);
  });

  it('with nothing at all says so', () => {
    const e = estimateIncomeTax(case2025({ businessProfitCents: null, wages: null }));
    expect(e.scope).toBe('none');
  });

  it('leaves church tax open when it was withheld but the months are not stated', () => {
    const e = estimateIncomeTax(case2025({ churchMonths: null, churchMonthsBasis: null }));
    expect(e.missing.map((m) => m.code)).toEqual(['church_months']);
    expect(e.churchTax.assessedCents).toBeNull();
    expect(e.totalBalanceCents).toBeNull();
    expect(e.totalWithoutChurchCents).toBe(-424_976);
  });

  it('assumes no church tax when none was withheld and nothing is stated', () => {
    const wages = aggregateWages([entry(0, { grossCents: 4_000_000, wageTaxCents: 500_000 })], false);
    const e = estimateIncomeTax(case2025({ wages, churchMonths: null, churchMonthsBasis: null }));
    expect(e.churchTax.assessedCents).toBe(0);
    expect(e.assumptions.join(' ')).toMatch(/ohne Kirchensteuerpflicht/);
  });

  it('needs the federal state for the church tax rate', () => {
    const e = estimateIncomeTax(case2025({ federalState: null }));
    expect(e.missing.map((m) => m.code)).toEqual(['federal_state']);
    expect(e.churchTax.assessedCents).toBeNull();
  });

  it('uses 8 percent in Bavaria', () => {
    const e = estimateIncomeTax(case2025({ federalState: 'BY', churchMonths: months(1, 12) }));
    expect(e.churchTax.assessedCents).toBe(Math.floor((3_822 * 800 * 12) / 1200));
  });

  it('marks a year without its own rules', () => {
    const e = estimateIncomeTax(case2025({ year: 2027 }));
    expect(e.rulesExact).toBe(false);
    expect(e.rulesYear).toBe(2026);
  });
});

describe('estimateIncomeTax: the rules one by one', () => {
  const plain = (overrides: Partial<EstimateInput> = {}): EstimateInput => ({
    year: 2026,
    businessProfitCents: 0,
    wages: aggregateWages([entry(0, { grossCents: 5_000_000, wageTaxCents: 700_000 })], false),
    employmentReceiptsCents: 0,
    returnItems: [],
    churchMonths: months(1, 0),
    churchMonthsBasis: 'stated',
    federalState: 'BE',
    ...overrides,
  });

  it('deducts the employee flat allowance when the work-related costs are lower', () => {
    const e = estimateIncomeTax(plain({ employmentReceiptsCents: 50_000 }));
    expect(figure(e, 'employment.deducted').cents).toBe(-123_000);
    expect(figure(e, 'employment.deducted').label).toMatch(/Pauschbetrag/);
  });

  it('commutes at 0.38 from the first kilometre in 2026, and 0.30 for the first 20 in 2025', () => {
    const items = [item('employment.commute', { days: 100, distanceKm: 30 })];
    expect(figure(estimateIncomeTax(plain({ returnItems: items })), 'employment.commute').cents).toBe(100 * 30 * 38);
    expect(figure(estimateIncomeTax(plain({ year: 2025, returnItems: items })), 'employment.commute').cents).toBe(100 * (20 * 30 + 10 * 38));
  });

  it('caps the home-office days at 210', () => {
    const e = estimateIncomeTax(plain({ returnItems: [item('employment.home_office_days', { days: 250 })] }));
    expect(figure(e, 'employment.home_office').cents).toBe(126_000);
  });

  it('caps own vocational training at 6,000 euros and uses the special expenses flat amount below 36 euros', () => {
    expect(figure(estimateIncomeTax(plain({ returnItems: [item('special.vocational_training', { amountCents: 900_000 })] })), 'special.training').cents).toBe(600_000);
    expect(figure(estimateIncomeTax(plain()), 'special.total').cents).toBe(-3_600);
  });

  it('caps donations at 20 percent of the total amount of income', () => {
    const e = estimateIncomeTax(plain({ wages: aggregateWages([entry(0, { grossCents: 1_323_000 })], false), returnItems: [item('special.donations', { amountCents: 500_000 })] }));
    // 13,230 - 1,230 = 12,000 euros income; 20 % = 2,400.
    expect(figure(e, 'special.donations').cents).toBe(240_000);
  });

  it('adds a church tax refund above what was paid to the income', () => {
    const e = estimateIncomeTax(plain({ returnItems: [item('special.church_tax_refunded', { amountCents: 34_676 })] }));
    expect(figure(e, 'income.church_excess').cents).toBe(34_600);
    expect(figure(e, 'special.church').cents).toBe(0);
  });

  it('counts other insurance only within the cap left by the basic contributions', () => {
    const low = aggregateWages([entry(0, { grossCents: 1_500_000, healthEmployeeCents: 100_000, careEmployeeCents: 20_000, unemploymentEmployeeCents: 100_000 })], false);
    const e = estimateIncomeTax(plain({ wages: low }));
    // Basic: 1,000 - 40 + 200 = 1,160; cap 1,900 leaves 740 of the 1,000 unemployment.
    expect(figure(e, 'insurance.basic').cents).toBe(116_000);
    expect(figure(e, 'insurance.other').cents).toBe(74_000);
  });

  it('charges the solidarity surcharge with the phase-in above the exemption limit', () => {
    const rich = aggregateWages([entry(0, { grossCents: 11_000_000 })], false);
    const e = estimateIncomeTax(plain({ wages: rich }));
    const tax = e.incomeTax.assessedCents as number;
    expect(tax).toBeGreaterThan(2_035_000);
    expect(e.solidarity.assessedCents).toBe(Math.min(Math.floor((tax * 550) / 10_000), Math.floor(((tax - 2_035_000) * 1190) / 10_000)));
  });

  it('credits advance payments and reports a payment as positive', () => {
    const e = estimateIncomeTax(plain({ wages: aggregateWages([entry(0, { grossCents: 5_000_000, wageTaxCents: 0 })], false), returnItems: [item('prepayment.income_tax', { amountCents: 100_000 })] }));
    expect(e.incomeTax.prepaidCents).toBe(100_000);
    expect(e.incomeTax.balanceCents).toBe((e.incomeTax.assessedCents as number) - 100_000);
    expect(e.incomeTax.balanceCents as number).toBeGreaterThan(0);
  });

  it('never raises the tax when a deductible cost rises (property)', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let cents = 0; cents <= 1_000_000; cents += 37_000) {
      const tax = estimateIncomeTax(plain({ employmentReceiptsCents: cents })).incomeTax.assessedCents as number;
      expect(tax).toBeLessThanOrEqual(previous);
      previous = tax;
    }
  });

  it('a business profit raises the tax, a loss lowers it', () => {
    const base = estimateIncomeTax(plain()).incomeTax.assessedCents as number;
    expect(estimateIncomeTax(plain({ businessProfitCents: 1_000_000 })).incomeTax.assessedCents as number).toBeGreaterThan(base);
    expect(estimateIncomeTax(plain({ businessProfitCents: -1_000_000 })).incomeTax.assessedCents as number).toBeLessThan(base);
  });

  it('says it does not carry a loss forward when the taxable income is negative', () => {
    const e = estimateIncomeTax(plain({ businessProfitCents: -10_000_000 }));
    expect(e.taxableIncomeEuros).toBe(0);
    expect(e.notCovered.join(' ')).toMatch(/Verlustvortrag/);
  });
});
