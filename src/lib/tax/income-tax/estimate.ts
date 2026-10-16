import type { Source } from '../rules/types';
import { itemsOf, sumAmount, sumDays, type ReturnItemFact } from './return-items';
import { incomeTaxRulesForYear, type FederalState, type IncomeTaxRules } from './rules';
import { tariffTaxEuros, tariffZone } from './tariff';
import type { YearWages } from './wages';

/**
 * The income tax estimate of one year for one person assessed alone.
 *
 * Pure: `estimateIncomeTax(input)` takes the business result of the
 * income-surplus statement, the wages, the employment annex costs the
 * statement computes from receipts and the other return items, and returns
 * every step of the calculation with its inputs and its legal source, down to
 * the expected refund or payment.
 *
 * Rounding follows the tax office: every amount enters in whole euros, in the
 * taxpayer's favour (income rounded down, deductions rounded up, amounts that
 * reduce a deduction rounded down); taxable income and the tax are rounded
 * down as the tariff says. Taxes withheld and paid are credited to the cent.
 */

export type FigureOrigin =
  | 'wage_statement'
  | 'pay_slips'
  | 'statement'
  | 'receipts'
  | 'return_item'
  | 'rule'
  | 'computed';

export interface FigureInput {
  label: string;
  /** Cents; null for a count or a text. */
  cents: number | null;
  text?: string;
  origin: FigureOrigin;
}

export interface Figure {
  id: string;
  label: string;
  /** Cents, already whole euros where the tax office works in euros. */
  cents: number;
  inputs: FigureInput[];
  source?: Source;
  note?: string;
}

export interface FigureSection {
  id: 'business' | 'employment' | 'income' | 'special' | 'insurance' | 'taxable' | 'tax' | 'credits' | 'result';
  title: string;
  figures: Figure[];
}

export type MissingInputCode =
  /** No invoice is recorded, so the statement has no result yet. */
  | 'business_result'
  /** No wage statement and no pay slip for the year. */
  | 'wages'
  /** Pay slips leave months out between the first and the last. */
  | 'pay_slip_gap'
  /** Church tax was withheld, but the months of liability are not stated. */
  | 'church_months'
  /** Church tax is due in some month, but the federal state (and with it the rate) is not set. */
  | 'federal_state';

export interface MissingInput {
  code: MissingInputCode;
  text: string;
}

export interface EstimateInput {
  year: number;
  /** Profit (positive) or loss (negative) of the income-surplus statement; null while it cannot be stated. */
  businessProfitCents: number | null;
  wages: YearWages | null;
  /** The employment annex amount lines the statement computes from receipts (study costs, work equipment). */
  employmentReceiptsCents: number;
  /** Receipt amounts on the structured employment lines (commute, home office): replaced by the flat rates, never added. */
  employmentStructuredReceiptsCents?: number;
  returnItems: readonly ReturnItemFact[];
  /** Twelve flags, January first: church tax due in that month. Null: not stated. */
  churchMonths: boolean[] | null;
  churchMonthsBasis: 'stated' | 'pay_slips' | null;
  federalState: FederalState | null;
}

export interface TaxBalance {
  /** What the assessment sets. Null when it cannot be computed (church tax without months or rate). */
  assessedCents: number | null;
  /** Withheld from wages. */
  withheldCents: number;
  prepaidCents: number;
  /** Assessed minus withheld minus prepaid: positive is a payment, negative a refund. Null with `assessedCents`. */
  balanceCents: number | null;
}

export interface IncomeTaxEstimate {
  year: number;
  rulesYear: number;
  rulesExact: boolean;
  rulesReviewedOn: string;
  /**
   * What the estimate covers. `business_only`: no wage data, so the
   * employment part is left out (the edge case of the plan: prompt to enter
   * one pay slip). `without_business`: wages but no business result.
   * `none`: neither, nothing to estimate.
   */
  scope: 'full' | 'business_only' | 'without_business' | 'none';
  missing: MissingInput[];
  assumptions: string[];
  notCovered: string[];
  sections: FigureSection[];
  taxableIncomeEuros: number;
  incomeTax: TaxBalance;
  solidarity: TaxBalance;
  churchTax: TaxBalance;
  /** Sum of the three balances; null when church tax cannot be computed (then see `totalWithoutChurchCents`). */
  totalBalanceCents: number | null;
  totalWithoutChurchCents: number;
  /** The total balance minus the total balance with a business result of zero: what the business changed in the tax. */
  businessEffectCents: number | null;
}

const floorEuro = (cents: number) => Math.floor(cents / 100) * 100;
const ceilEuro = (cents: number) => Math.ceil(cents / 100) * 100;
const bp = (cents: number, basisPoints: number) => Math.floor((cents * basisPoints) / 10_000);
/** Minus, without a negative zero in the figures a screen or a test reads. */
const neg = (cents: number) => (cents === 0 ? 0 : -cents);
const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

const RULE_ORIGIN = 'rule' as const;
const EXCESS_SOURCE: Source = {
  citation: '§ 10 Abs. 4b Satz 3 Einkommensteuergesetz (Erstattungsüberhang)',
  url: 'https://www.gesetze-im-internet.de/estg/__10.html',
  checkedOn: '2026-10-15',
};

export function estimateIncomeTax(input: EstimateInput): IncomeTaxEstimate {
  const { rules, exact } = incomeTaxRulesForYear(input.year);
  const full = compute(input, rules);
  let businessEffectCents: number | null = null;
  if (input.businessProfitCents !== null && input.businessProfitCents !== 0) {
    const without = compute({ ...input, businessProfitCents: 0 }, rules);
    const total = (e: Computed) => e.totalBalanceCents ?? e.totalWithoutChurchCents;
    businessEffectCents = total(full) - total(without);
  }
  return { ...full, year: input.year, rulesYear: rules.year, rulesExact: exact, rulesReviewedOn: rules.reviewedOn, businessEffectCents };
}

type Computed = Omit<IncomeTaxEstimate, 'year' | 'rulesYear' | 'rulesExact' | 'rulesReviewedOn' | 'businessEffectCents'>;

function wageOrigin(wages: YearWages): FigureOrigin {
  return wages.employers.every((e) => e.basis === 'annual_statement') ? 'wage_statement' : 'pay_slips';
}

function compute(input: EstimateInput, rules: IncomeTaxRules): Computed {
  const items = input.returnItems;
  const wages = input.wages;
  const missing: MissingInput[] = [];
  const assumptions: string[] = [];
  const notCovered: string[] = [
    'Zusammenveranlagung, Kinder, Kapitalerträge und Vermietung sind nicht abgedeckt.',
    'Die Günstigerprüfung des Finanzamts für Vorsorgeaufwendungen wird nicht nachgerechnet; gerechnet wird nach der Regel von § 10 Abs. 4 EStG.',
  ];
  const sections: FigureSection[] = [];

  // ── Business ────────────────────────────────────────────────────────────
  const hasBusiness = input.businessProfitCents !== null;
  const businessCents = hasBusiness ? floorEuro(input.businessProfitCents as number) : 0;
  if (!hasBusiness) {
    missing.push({
      code: 'business_result',
      text: 'Ohne erfasste Rechnungen hat die Einnahmenüberschussrechnung noch kein Ergebnis. Das Gewerbe fehlt in dieser Schätzung.',
    });
  } else {
    sections.push({
      id: 'business',
      title: 'Gewerbebetrieb (Anlage G)',
      figures: [
        {
          id: 'business.result',
          label: (input.businessProfitCents as number) < 0 ? 'Verlust laut Einnahmenüberschussrechnung' : 'Gewinn laut Einnahmenüberschussrechnung',
          cents: businessCents,
          inputs: [{ label: 'Ergebnis der Einnahmenüberschussrechnung (EÜR)', cents: input.businessProfitCents, origin: 'statement' }],
          note: 'In vollen Euro, zugunsten abgerundet.',
        },
      ],
    });
    if (businessCents > 2_450_000) notCovered.push('Die Anrechnung der Gewerbesteuer (§ 35 EStG) ist nicht abgedeckt.');
  }

  // ── Employment ──────────────────────────────────────────────────────────
  let employmentIncomeCents = 0;
  const hasWages = wages !== null;
  if (!hasWages) {
    missing.push({
      code: 'wages',
      text: 'Für dieses Jahr sind keine Lohndaten erfasst. Die Schätzung zeigt nur das Gewerbe; eine Lohnabrechnung reicht für den Anfang.',
    });
    const homeOffice = sumDays(items, 'employment.home_office_days');
    if (
      input.employmentReceiptsCents > 0 ||
      homeOffice > 0 ||
      itemsOf(items, 'employment.commute').length > 0 ||
      sumAmount(items, 'employment.other') > 0 ||
      sumAmount(items, 'employment.union_dues') > 0
    ) {
      assumptions.push('Werbungskosten der Anlage N zählen erst mit Lohndaten und sind deshalb nicht enthalten.');
    }
  } else {
    const origin = wageOrigin(wages);
    for (const e of wages.employers) {
      if (e.gaps.length > 0) {
        missing.push({
          code: 'pay_slip_gap',
          text: `${e.employer}: zwischen den Lohnabrechnungen fehlen ${e.gaps.map((m) => MONTH_NAMES[m - 1]).join(', ')}.`,
        });
      }
      if (e.projectedMonths.length > 0) {
        assumptions.push(
          `${e.employer}: ${e.projectedMonths.map((m) => MONTH_NAMES[m - 1]).join(', ')} mit den Zahlen der letzten Lohnabrechnung hochgerechnet.`,
        );
      }
      if (e.ignoredPaySlips > 0) {
        assumptions.push(`${e.employer}: Es gilt die Lohnsteuerbescheinigung; ${e.ignoredPaySlips} Lohnabrechnungen werden nur angezeigt.`);
      }
    }
    const grossCents = floorEuro(wages.total.grossCents);
    const receiptsCents = ceilEuro(input.employmentReceiptsCents);
    const homeOfficeDays = sumDays(items, 'employment.home_office_days');
    const countedDays = Math.min(homeOfficeDays, rules.homeOfficeDay.value.maxDays);
    const homeOfficeCents = countedDays * rules.homeOfficeDay.value.centsPerDay;
    const commuteRate = rules.commute.value;
    const commuteInputs: FigureInput[] = [];
    // The 4,500 euro cap applies to every way of commuting except one's own car
    // or a car provided for use (§ 9 Abs. 2 EStG), so those trips are added
    // uncapped and the rest is capped. Rounded up once, on the total.
    let carCents = 0;
    let otherWaysCents = 0;
    for (const c of itemsOf(items, 'employment.commute')) {
      const km = c.distanceKm ?? 0;
      const days = c.days ?? 0;
      const perDay = Math.min(km, 20) * commuteRate.firstKmCents + Math.max(km - 20, 0) * commuteRate.from21stKmCents;
      if (c.ownCar) carCents += days * perDay;
      else otherWaysCents += days * perDay;
      commuteInputs.push({
        label: `${c.note || 'Weg'}${c.ownCar ? ' (eigener oder überlassener Wagen)' : ''}`,
        cents: days * perDay,
        text: `${days} Tage × ${km} km`,
        origin: 'return_item',
      });
    }
    const cappedOtherWays = Math.min(otherWaysCents, commuteRate.capCents);
    if (cappedOtherWays < otherWaysCents) {
      commuteInputs.push({ label: 'Höchstbetrag ohne eigenen oder überlassenen Wagen', cents: commuteRate.capCents, origin: RULE_ORIGIN });
    }
    const commuteCents = ceilEuro(carCents + cappedOtherWays);
    const otherItems = itemsOf(items, 'employment.other');
    const otherCents = otherItems.reduce((s, i) => s + ceilEuro(i.amountCents ?? 0), 0);
    // Union dues: work-related costs like any other until 2025; from 2026 they
    // count in addition to the employee flat allowance (§ 9a Satz 3 EStG).
    const unionItems = itemsOf(items, 'employment.union_dues');
    const unionCents = unionItems.reduce((s, i) => s + ceilEuro(i.amountCents ?? 0), 0);
    const unionBeside = rules.unionDuesBesideFlatAllowance.value;
    const workCostsCents = receiptsCents + homeOfficeCents + commuteCents + otherCents + (unionBeside ? 0 : unionCents);
    const flat = rules.employeeFlatAllowanceCents.value;
    // The flat allowance never makes a loss: it is deducted only up to the wage (§ 9a Satz 2 EStG).
    const flatUsed = Math.min(flat, Math.max(grossCents, 0));
    const deductedCents = Math.max(workCostsCents, flatUsed) + (unionBeside ? unionCents : 0);
    employmentIncomeCents = grossCents - deductedCents;
    if ((input.employmentStructuredReceiptsCents ?? 0) > 0) {
      assumptions.push(
        'Belege auf den Zeilen für Wege und Homeoffice zählen hier nicht: dafür gelten die Pauschalen aus Tagen und Entfernung.',
      );
    }
    sections.push({
      id: 'employment',
      title: 'Nichtselbständige Arbeit (Anlage N)',
      figures: [
        {
          id: 'employment.gross',
          label: 'Bruttoarbeitslohn',
          cents: grossCents,
          inputs: wages.employers.map((e) => ({
            label: `${e.employer} (${e.basis === 'annual_statement' ? 'Lohnsteuerbescheinigung' : `${e.months.length} Lohnabrechnungen${e.projectedMonths.length ? ` + ${e.projectedMonths.length} hochgerechnet` : ''}`})`,
            cents: e.figures.grossCents,
            origin: e.basis === 'annual_statement' ? 'wage_statement' : 'pay_slips',
          })),
          note: 'In vollen Euro, abgerundet.',
        },
        {
          id: 'employment.home_office',
          label: 'Tagespauschale Homeoffice',
          cents: homeOfficeCents,
          inputs: [
            { label: 'Tage', cents: null, text: `${homeOfficeDays}${homeOfficeDays > countedDays ? ` (gezählt ${countedDays})` : ''}`, origin: 'return_item' },
            { label: 'je Tag', cents: rules.homeOfficeDay.value.centsPerDay, origin: RULE_ORIGIN },
          ],
          source: rules.homeOfficeDay.source,
        },
        { id: 'employment.commute', label: 'Entfernungspauschale', cents: commuteCents, inputs: commuteInputs, source: rules.commute.source },
        {
          id: 'employment.receipts',
          label: 'Belege der Anlage N (Fortbildung, Arbeitsmittel, Sonstiges)',
          cents: receiptsCents,
          inputs: [{ label: 'Betragszeilen der Anlage N aus den Belegen (Ansicht EÜR)', cents: input.employmentReceiptsCents, origin: 'receipts' }],
        },
        {
          id: 'employment.other',
          label: 'Weitere Werbungskosten',
          cents: otherCents,
          inputs: otherItems.map((i) => ({ label: i.note || 'Eintrag', cents: i.amountCents, origin: 'return_item' as const })),
        },
        {
          id: 'employment.union_dues',
          label: unionBeside ? 'Gewerkschaftsbeiträge (neben dem Pauschbetrag)' : 'Gewerkschaftsbeiträge',
          cents: unionCents,
          inputs: unionItems.map((i) => ({ label: i.note || 'Eintrag', cents: i.amountCents, origin: 'return_item' as const })),
          source: rules.unionDuesBesideFlatAllowance.source,
        },
        {
          id: 'employment.deducted',
          label:
            workCostsCents >= flatUsed
              ? `Werbungskosten${unionBeside && unionCents > 0 ? ' und Gewerkschaftsbeiträge' : ''}`
              : `Arbeitnehmer-Pauschbetrag (höher als die Werbungskosten)${unionBeside && unionCents > 0 ? ' und Gewerkschaftsbeiträge' : ''}`,
          cents: neg(deductedCents),
          inputs: [
            { label: 'Werbungskosten zusammen', cents: workCostsCents, origin: 'computed' },
            { label: 'Arbeitnehmer-Pauschbetrag', cents: flat, origin: RULE_ORIGIN },
            ...(flatUsed < flat ? [{ label: 'höchstens bis zum Arbeitslohn', cents: flatUsed, origin: RULE_ORIGIN }] : []),
          ],
          source: rules.employeeFlatAllowanceCents.source,
        },
        { id: 'employment.income', label: 'Einkünfte aus nichtselbständiger Arbeit', cents: employmentIncomeCents, inputs: [], note: `Lohndaten: ${origin === 'wage_statement' ? 'Lohnsteuerbescheinigung' : 'Lohnabrechnungen'}.` },
      ],
    });
  }

  // ── Total amount of income ──────────────────────────────────────────────
  const sumOfIncomeCents = businessCents + employmentIncomeCents;
  const churchFromWagesCents = wages?.total.churchTaxCents ?? 0;
  // Church tax paid in the year besides the wage: on an assessment, and the advance payments.
  const churchPaidOtherCents = sumAmount(items, 'special.church_tax_paid') + sumAmount(items, 'prepayment.church_tax');
  const churchRefundedCents = sumAmount(items, 'special.church_tax_refunded');
  const churchNetCents = ceilEuro(churchFromWagesCents + churchPaidOtherCents) - floorEuro(churchRefundedCents);
  // A refund above what was paid in the year is added to the income (§ 10 Abs. 4b Satz 3 EStG):
  // for church tax, and for health and care contributions.
  const churchExcessCents = churchNetCents < 0 ? -churchNetCents : 0;

  const w = wages?.total;
  const wageHealthCents = ceilEuro(w?.healthEmployeeCents ?? 0);
  const selfSickPayRaw = sumAmount(items, 'insurance.health_self_paid_sick_pay');
  const selfSickPayCents = ceilEuro(selfSickPayRaw);
  const selfHealthCents = ceilEuro(sumAmount(items, 'insurance.health_self_paid'));
  const healthCents = wageHealthCents + selfSickPayCents + selfHealthCents;
  // The 4 percent come off the contributions as paid, rounded down in the taxpayer's favour.
  const reductionCents = floorEuro(bp((wages?.healthWithSickPayCents ?? 0) + selfSickPayRaw, rules.sickPayReductionBp.value));
  const careCents = ceilEuro(w?.careEmployeeCents ?? 0) + ceilEuro(sumAmount(items, 'insurance.care_self_paid'));
  const refundedCents = floorEuro(sumAmount(items, 'insurance.refunded'));
  const basicRawCents = healthCents - reductionCents + careCents - refundedCents;
  const basicCents = Math.max(basicRawCents, 0);
  const insuranceExcessCents = basicRawCents < 0 ? -basicRawCents : 0;
  const totalIncomeCents = sumOfIncomeCents + churchExcessCents + insuranceExcessCents;
  sections.push({
    id: 'income',
    title: 'Summe der Einkünfte',
    figures: [
      {
        id: 'income.sum',
        label: 'Summe der Einkünfte',
        cents: sumOfIncomeCents,
        inputs: [
          { label: 'Gewerbebetrieb', cents: businessCents, origin: 'computed' },
          { label: 'Nichtselbständige Arbeit', cents: employmentIncomeCents, origin: 'computed' },
        ],
        note: 'Ein Verlust aus dem Gewerbe wird mit dem Lohn desselben Jahres verrechnet.',
      },
      ...(churchExcessCents > 0
        ? [
            {
              id: 'income.church_excess',
              label: 'Hinzurechnung: Kirchensteuer-Erstattungsüberhang',
              cents: churchExcessCents,
              inputs: [{ label: 'erstattet minus gezahlt', cents: churchExcessCents, origin: 'computed' as const }],
              source: EXCESS_SOURCE,
            },
          ]
        : []),
      ...(insuranceExcessCents > 0
        ? [
            {
              id: 'income.insurance_excess',
              label: 'Hinzurechnung: Erstattungsüberhang Kranken- und Pflegeversicherung',
              cents: insuranceExcessCents,
              inputs: [{ label: 'erstattet minus gezahlt', cents: insuranceExcessCents, origin: 'computed' as const }],
              source: EXCESS_SOURCE,
            },
          ]
        : []),
      { id: 'income.total', label: 'Gesamtbetrag der Einkünfte', cents: totalIncomeCents, inputs: [] },
    ],
  });

  // ── Special expenses without a cap ──────────────────────────────────────
  const churchDeductionCents = Math.max(churchNetCents, 0);
  const trainingRaw = sumAmount(items, 'special.vocational_training');
  const trainingCents = Math.min(ceilEuro(trainingRaw), rules.vocationalTrainingCapCents.value);
  const donationsRaw = sumAmount(items, 'special.donations');
  // Measured on the income before any refund excess is added.
  const donationsCap = Math.max(floorEuro(bp(sumOfIncomeCents, rules.donationsCapBp.value)), 0);
  const donationsCents = Math.min(ceilEuro(donationsRaw), donationsCap);
  const specialActual = churchDeductionCents + trainingCents + donationsCents;
  const specialCents = Math.max(specialActual, rules.specialExpensesFlatCents.value);
  sections.push({
    id: 'special',
    title: 'Sonderausgaben',
    figures: [
      {
        id: 'special.church',
        label: 'Gezahlte Kirchensteuer',
        cents: churchDeductionCents,
        inputs: [
          { label: 'vom Lohn einbehalten', cents: churchFromWagesCents, origin: wages ? wageOrigin(wages) : 'computed' },
          { label: 'sonst gezahlt (Bescheid, Vorauszahlungen)', cents: churchPaidOtherCents, origin: 'return_item' },
          { label: 'erstattet', cents: neg(churchRefundedCents), origin: 'return_item' },
        ],
      },
      {
        id: 'special.training',
        label: 'Eigene Berufsausbildung',
        cents: trainingCents,
        inputs: itemsOf(items, 'special.vocational_training').map((i) => ({ label: i.note || 'Eintrag', cents: i.amountCents, origin: 'return_item' as const })),
        source: rules.vocationalTrainingCapCents.source,
      },
      {
        id: 'special.donations',
        label: 'Spenden',
        cents: donationsCents,
        inputs: [{ label: 'eingetragen', cents: donationsRaw, origin: 'return_item' }, { label: 'Höchstbetrag', cents: donationsCap, origin: RULE_ORIGIN }],
        source: rules.donationsCapBp.source,
      },
      {
        id: 'special.total',
        label: specialActual >= rules.specialExpensesFlatCents.value ? 'Sonderausgaben zusammen' : 'Sonderausgaben-Pauschbetrag (höher)',
        cents: -specialCents,
        inputs: [{ label: 'Pauschbetrag', cents: rules.specialExpensesFlatCents.value, origin: RULE_ORIGIN }],
        source: rules.specialExpensesFlatCents.source,
      },
    ],
  });

  // ── Insurance contributions ─────────────────────────────────────────────
  const pensionEmployerCents = floorEuro(w?.pensionEmployerCents ?? 0);
  const pensionAllCents = ceilEuro((w?.pensionEmployeeCents ?? 0) + (w?.pensionEmployerCents ?? 0) + sumAmount(items, 'insurance.pension_self_paid'));
  const pensionCapped = Math.min(pensionAllCents, rules.pension.value.capCents);
  const pensionCents = Math.max(bp(pensionCapped, rules.pension.value.deductibleBp) - pensionEmployerCents, 0);

  const otherInsuranceCents = ceilEuro(w?.unemploymentEmployeeCents ?? 0) + ceilEuro(sumAmount(items, 'insurance.other'));
  const cap = hasWages ? rules.otherInsuranceCapCents.value.employee : rules.otherInsuranceCapCents.value.selfPaid;
  const limitedCents = Math.max(basicCents, Math.min(basicCents + otherInsuranceCents, cap));
  const insuranceCents = pensionCents + limitedCents;
  sections.push({
    id: 'insurance',
    title: 'Vorsorgeaufwendungen',
    figures: [
      {
        id: 'insurance.pension',
        label: 'Altersvorsorge',
        cents: pensionCents,
        inputs: [
          { label: 'Arbeitnehmer- und Arbeitgeberanteil, selbst gezahlt', cents: pensionAllCents, origin: 'computed' },
          { label: 'Höchstbetrag', cents: rules.pension.value.capCents, origin: RULE_ORIGIN },
          { label: 'abzüglich Arbeitgeberanteil', cents: neg(pensionEmployerCents), origin: wages ? wageOrigin(wages) : 'computed' },
        ],
        source: rules.pension.source,
      },
      {
        id: 'insurance.basic',
        label: 'Kranken- und Pflegeversicherung (Basis)',
        cents: basicCents,
        inputs: [
          { label: 'Krankenversicherung', cents: healthCents, origin: 'computed' },
          { label: 'Kürzung 4 % (Anspruch auf Krankengeld)', cents: neg(reductionCents), origin: RULE_ORIGIN },
          { label: 'Pflegeversicherung', cents: careCents, origin: 'computed' },
          { label: 'Beitragsrückerstattung', cents: neg(refundedCents), origin: 'return_item' },
        ],
        source: rules.sickPayReductionBp.source,
      },
      {
        id: 'insurance.other',
        label: 'Weitere Vorsorge (Arbeitslosen- und andere Versicherungen)',
        cents: limitedCents - basicCents,
        inputs: [
          { label: 'eingetragen', cents: otherInsuranceCents, origin: 'computed' },
          { label: 'Höchstbetrag zusammen mit den Basisbeiträgen', cents: cap, origin: RULE_ORIGIN },
        ],
        source: rules.otherInsuranceCapCents.source,
        note: basicCents >= cap ? 'Die Basisbeiträge übersteigen schon den Höchstbetrag: weitere Versicherungen wirken sich nicht aus.' : undefined,
      },
      { id: 'insurance.total', label: 'Vorsorgeaufwendungen zusammen', cents: neg(insuranceCents), inputs: [] },
    ],
  });

  // ── Taxable income and the tax ──────────────────────────────────────────
  const taxableCents = totalIncomeCents - specialCents - insuranceCents;
  const taxableEuros = Math.max(Math.floor(taxableCents / 100), 0);
  if (taxableCents < 0) {
    notCovered.push('Das zu versteuernde Einkommen ist negativ. Verlustrücktrag und Verlustvortrag (§ 10d EStG) rechnet die App nicht.');
  }
  sections.push({
    id: 'taxable',
    title: 'Zu versteuerndes Einkommen',
    figures: [{ id: 'taxable.income', label: 'Zu versteuerndes Einkommen', cents: taxableEuros * 100, inputs: [{ label: 'rechnerisch', cents: taxableCents, origin: 'computed' }] }],
  });

  const zones = rules.tariff.value;
  const incomeTaxEuros = tariffTaxEuros(taxableEuros, zones);
  const incomeTaxCents = incomeTaxEuros * 100;
  const soli = rules.solidarity.value;
  const soliCents =
    incomeTaxEuros <= soli.exemptionLimitEuros
      ? 0
      : Math.min(bp(incomeTaxCents, soli.rateBp), bp((incomeTaxEuros - soli.exemptionLimitEuros) * 100, soli.phaseInBp));

  // Church tax: the months of liability and the rate of the federal state.
  let churchMonths = input.churchMonths;
  if (churchMonths === null && churchFromWagesCents === 0 && churchPaidOtherCents === 0) {
    churchMonths = Array.from({ length: 12 }, () => false);
    assumptions.push('Keine Kirchensteuer einbehalten und keine Monate angegeben: gerechnet ohne Kirchensteuerpflicht.');
  } else if (input.churchMonthsBasis === 'pay_slips' && churchMonths) {
    assumptions.push('Kirchensteuerpflicht je Monat aus den Lohnabrechnungen abgeleitet; Monate ohne Abrechnung zählen als nicht pflichtig.');
  }
  const liableMonths = churchMonths ? churchMonths.filter(Boolean).length : null;
  if (churchMonths === null) {
    missing.push({ code: 'church_months', text: 'Kirchensteuer wurde einbehalten oder vorausgezahlt, aber die Monate der Kirchensteuerpflicht sind nicht angegeben.' });
  }
  let churchRateBp: number | null = null;
  if (liableMonths !== null && liableMonths > 0) {
    if (input.federalState === null) {
      missing.push({ code: 'federal_state', text: 'Für den Kirchensteuersatz fehlt das Bundesland.' });
    } else {
      churchRateBp = rules.churchTaxRateBp.value[input.federalState];
    }
  }
  const churchAssessedCents =
    liableMonths === null ? null : liableMonths === 0 ? 0 : churchRateBp === null ? null : Math.floor((incomeTaxEuros * churchRateBp * liableMonths) / 1200);

  sections.push({
    id: 'tax',
    title: 'Steuer',
    figures: [
      {
        id: 'tax.income',
        label: 'Einkommensteuer (Grundtarif)',
        cents: incomeTaxCents,
        inputs: [
          { label: 'zu versteuerndes Einkommen', cents: taxableEuros * 100, origin: 'computed' },
          { label: 'Tarifzone', cents: null, text: String(tariffZone(taxableEuros, zones)), origin: RULE_ORIGIN },
        ],
        source: rules.tariff.source,
      },
      {
        id: 'tax.solidarity',
        label: 'Solidaritätszuschlag',
        cents: soliCents,
        inputs: [{ label: 'Freigrenze (Einkommensteuer)', cents: soli.exemptionLimitEuros * 100, origin: RULE_ORIGIN }],
        source: rules.solidarity.source,
      },
      {
        id: 'tax.church',
        label: 'Kirchensteuer',
        cents: churchAssessedCents ?? 0,
        inputs: [
          { label: 'pflichtige Monate', cents: null, text: liableMonths === null ? 'nicht angegeben' : `${liableMonths} von 12`, origin: input.churchMonthsBasis === 'pay_slips' ? 'pay_slips' : 'return_item' },
          { label: 'Satz', cents: null, text: churchRateBp === null ? (liableMonths === 0 ? 'entfällt' : 'Bundesland fehlt') : `${churchRateBp / 100} %`, origin: RULE_ORIGIN },
        ],
        source: rules.churchTaxRateBp.source,
        note: churchAssessedCents === null ? 'Nicht berechenbar, siehe fehlende Angaben.' : undefined,
      },
    ],
  });

  // ── Credits and the result ──────────────────────────────────────────────
  const withheld = {
    income: w?.wageTaxCents ?? 0,
    soli: w?.solidarityCents ?? 0,
    church: w?.churchTaxCents ?? 0,
  };
  const prepaid = {
    income: sumAmount(items, 'prepayment.income_tax'),
    soli: sumAmount(items, 'prepayment.solidarity'),
    church: sumAmount(items, 'prepayment.church_tax'),
  };
  const balance = (assessed: number | null, withheldCents: number, prepaidCents: number): TaxBalance => ({
    assessedCents: assessed,
    withheldCents,
    prepaidCents,
    balanceCents: assessed === null ? null : assessed - withheldCents - prepaidCents,
  });
  const incomeTax = balance(incomeTaxCents, withheld.income, prepaid.income);
  const solidarity = balance(soliCents, withheld.soli, prepaid.soli);
  const churchTax = balance(churchAssessedCents, withheld.church, prepaid.church);
  const totalWithoutChurchCents = (incomeTax.balanceCents as number) + (solidarity.balanceCents as number);
  const totalBalanceCents = churchTax.balanceCents === null ? null : totalWithoutChurchCents + churchTax.balanceCents;
  sections.push({
    id: 'credits',
    title: 'Angerechnet',
    figures: [
      { id: 'credits.wage_tax', label: 'Lohnsteuer einbehalten', cents: neg(withheld.income), inputs: [], note: 'Auf den Cent angerechnet.' },
      { id: 'credits.soli', label: 'Solidaritätszuschlag einbehalten', cents: neg(withheld.soli), inputs: [] },
      { id: 'credits.church', label: 'Kirchensteuer einbehalten', cents: neg(withheld.church), inputs: [] },
      { id: 'credits.prepaid', label: 'Vorauszahlungen', cents: neg(prepaid.income + prepaid.soli + prepaid.church), inputs: [] },
    ],
  });
  sections.push({
    id: 'result',
    title: 'Ergebnis',
    figures: [
      { id: 'result.income', label: 'Einkommensteuer', cents: incomeTax.balanceCents as number, inputs: [] },
      { id: 'result.soli', label: 'Solidaritätszuschlag', cents: solidarity.balanceCents as number, inputs: [] },
      { id: 'result.church', label: 'Kirchensteuer', cents: churchTax.balanceCents ?? 0, inputs: [], note: churchTax.balanceCents === null ? 'nicht berechenbar' : undefined },
    ],
  });

  const scope: Computed['scope'] = hasWages && hasBusiness ? 'full' : hasBusiness ? 'business_only' : hasWages ? 'without_business' : 'none';
  return {
    scope,
    missing,
    assumptions,
    notCovered,
    sections,
    taxableIncomeEuros: taxableEuros,
    incomeTax,
    solidarity,
    churchTax,
    totalBalanceCents,
    totalWithoutChurchCents,
  };
}
