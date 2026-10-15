import type { Source, Sourced } from '../rules/types';

/**
 * The income tax values of one year, each with its legal source.
 *
 * Kept beside the year rule sets in `../rules` instead of inside them: the
 * statement and the estimate change for different reasons and on different
 * days (the tariff of a year is published long after its form lines), and a
 * year can have form lines before it has a tariff. A year without its own
 * values here is computed with the nearest year's and says so, exactly like
 * `rulesForYear`.
 */

/** One zone of the tariff of section 32a (1) of the income tax act, in whole euros of taxable income. */
export interface TariffZones {
  /** The basic allowance: up to this taxable income the tax is 0. */
  basicAllowance: number;
  /** Zone 2 ends here; `y` is a ten-thousandth of the income above the basic allowance. */
  zone2Upper: number;
  zone2: { a: number; b: number };
  /** Zone 3 ends here; `z` is a ten-thousandth of the income above `zone2Upper`. */
  zone3Upper: number;
  zone3: { a: number; b: number; c: number };
  /** Zone 4 ends here: 0.42 x minus `zone4Minus`. */
  zone4Upper: number;
  zone4Minus: number;
  /** Above: 0.45 x minus `zone5Minus`. */
  zone5Minus: number;
}

export interface IncomeTaxRules {
  year: number;
  /** ISO day a person last went through these values. */
  reviewedOn: string;
  tariff: Sourced<TariffZones>;
  /** Solidarity surcharge: rate, the exemption limit for a single assessment and the phase-in rate, in basis points and whole euros. */
  solidarity: Sourced<{ rateBp: number; exemptionLimitEuros: number; phaseInBp: number }>;
  /** Employee flat allowance: deducted instead of work-related costs when those are lower. */
  employeeFlatAllowanceCents: Sourced<number>;
  /** Special expenses flat amount, when church tax, training costs and donations together are lower. */
  specialExpensesFlatCents: Sourced<number>;
  /** Commuting: cents per full kilometre, for the first 20 km and from the 21st, and the yearly cap (not for one's own car). */
  commute: Sourced<{ firstKmCents: number; from21stKmCents: number; capCents: number }>;
  /** Home-office day flat rate and the most days it may be claimed for. */
  homeOfficeDay: Sourced<{ centsPerDay: number; maxDays: number }>;
  /** Costs of one's own first vocational training, deductible as special expenses up to this amount. */
  vocationalTrainingCapCents: Sourced<number>;
  /** Donations: deductible up to this share of the total amount of income. */
  donationsCapBp: Sourced<number>;
  /** Pension contributions: the cap (knappschaft maximum contribution) and the deductible share. */
  pension: Sourced<{ capCents: number; deductibleBp: number }>;
  /** Health insurance contributions that carry a claim to sick pay count 4 percent less. */
  sickPayReductionBp: Sourced<number>;
  /** Cap on health, care and other insurance contributions; basic health and care contributions count in full above it. */
  otherInsuranceCapCents: Sourced<{ employee: number; selfPaid: number }>;
  /** Church tax rate in basis points of the income tax, per federal state. */
  churchTaxRateBp: Sourced<Record<FederalState, number>>;
}

export const FEDERAL_STATES = ['BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH'] as const;
export type FederalState = (typeof FEDERAL_STATES)[number];

export function isFederalState(value: unknown): value is FederalState {
  return typeof value === 'string' && (FEDERAL_STATES as readonly string[]).includes(value);
}

export const FEDERAL_STATE_LABELS: Record<FederalState, string> = {
  BW: 'Baden-Württemberg',
  BY: 'Bayern',
  BE: 'Berlin',
  BB: 'Brandenburg',
  HB: 'Bremen',
  HH: 'Hamburg',
  HE: 'Hessen',
  MV: 'Mecklenburg-Vorpommern',
  NI: 'Niedersachsen',
  NW: 'Nordrhein-Westfalen',
  RP: 'Rheinland-Pfalz',
  SL: 'Saarland',
  SN: 'Sachsen',
  ST: 'Sachsen-Anhalt',
  SH: 'Schleswig-Holstein',
  TH: 'Thüringen',
};

const estg = (paragraph: string, citation: string, checkedOn: string): Source => ({
  citation,
  url: `https://www.gesetze-im-internet.de/estg/__${paragraph}.html`,
  checkedOn,
});

/** 8 percent in Bavaria and Baden-Württemberg, 9 percent in every other state (the church tax acts of the states). */
const CHURCH_RATES: Record<FederalState, number> = Object.fromEntries(
  FEDERAL_STATES.map((s) => [s, s === 'BW' || s === 'BY' ? 800 : 900]),
) as Record<FederalState, number>;

const CHURCH_RATE_SOURCE: Source = {
  citation:
    'Kirchensteuergesetze der Länder: 8 Prozent der Einkommensteuer in Bayern und Baden-Württemberg, 9 Prozent in den übrigen Ländern (Berlin: Kirchensteuergesetz Berlin; die 9 Prozent bestätigt die vorläufige Berechnung des Finanzamts für 2025)',
  url: 'https://gesetze.berlin.de/bsbe/document/jlr-KiStGBErahmen',
  checkedOn: '2026-10-15',
};

/** Values that are the same in 2025 and 2026, each with its own source. */
const COMMON = {
  solidarityRate: { rateBp: 550, phaseInBp: 1190 },
  employeeFlatAllowanceCents: {
    value: 123_000,
    source: estg('9a', '§ 9a Satz 1 Nr. 1 Buchstabe a Einkommensteuergesetz (Arbeitnehmer-Pauschbetrag 1.230 Euro)', '2026-10-15'),
  },
  specialExpensesFlatCents: {
    value: 3_600,
    source: estg('10c', '§ 10c Satz 1 Einkommensteuergesetz (Sonderausgaben-Pauschbetrag 36 Euro)', '2026-10-15'),
  },
  homeOfficeDay: {
    value: { centsPerDay: 600, maxDays: 210 },
    source: estg('4', '§ 4 Abs. 5 Satz 1 Nr. 6c Einkommensteuergesetz (Tagespauschale 6 Euro, höchstens 1.260 Euro im Jahr)', '2026-10-15'),
  },
  vocationalTrainingCapCents: {
    value: 600_000,
    source: estg('10', '§ 10 Abs. 1 Nr. 7 Einkommensteuergesetz (eigene Berufsausbildung bis 6.000 Euro im Kalenderjahr)', '2026-10-15'),
  },
  donationsCapBp: {
    value: 2000,
    source: estg('10b', '§ 10b Abs. 1 Satz 1 Nr. 1 Einkommensteuergesetz (bis 20 Prozent des Gesamtbetrags der Einkünfte)', '2026-10-15'),
  },
  sickPayReductionBp: {
    value: 400,
    source: estg('10', '§ 10 Abs. 1 Nr. 3 Buchstabe a Satz 4 Einkommensteuergesetz (Kürzung um 4 Prozent bei Anspruch auf Krankengeld)', '2026-10-15'),
  },
  otherInsuranceCapCents: {
    value: { employee: 190_000, selfPaid: 280_000 },
    source: estg('10', '§ 10 Abs. 4 Einkommensteuergesetz (1.900 Euro mit steuerfreiem Arbeitgeberzuschuss, sonst 2.800 Euro; Basisbeiträge mindestens in voller Höhe)', '2026-10-15'),
  },
  churchTaxRateBp: { value: CHURCH_RATES, source: CHURCH_RATE_SOURCE },
};

export const INCOME_TAX_RULES_2025: IncomeTaxRules = {
  year: 2025,
  reviewedOn: '2026-10-15',
  tariff: {
    value: {
      basicAllowance: 12_096,
      zone2Upper: 17_443,
      zone2: { a: 932.3, b: 1_400 },
      zone3Upper: 68_480,
      zone3: { a: 176.64, b: 2_397, c: 1_015.13 },
      zone4Upper: 277_825,
      zone4Minus: 10_911.92,
      zone5Minus: 19_246.67,
    },
    source: {
      citation:
        '§ 32a Abs. 1 Einkommensteuergesetz in der Fassung des Steuerfortentwicklungsgesetzes vom 23. Dezember 2024 (BGBl. 2024 I Nr. 449), Veranlagungszeitraum 2025',
      url: 'https://www.recht.bund.de/bgbl/1/2024/449/VO.html',
      checkedOn: '2026-10-15',
    },
  },
  solidarity: {
    value: { ...COMMON.solidarityRate, exemptionLimitEuros: 19_950 },
    source: {
      citation: '§ 3 Abs. 3 und § 4 Solidaritätszuschlaggesetz 1995 für 2025 (Freigrenze 19.950 Euro, 5,5 Prozent, höchstens 11,9 Prozent des Unterschieds)',
      url: 'https://www.gesetze-im-internet.de/solzg_1995/',
      checkedOn: '2026-10-15',
    },
  },
  employeeFlatAllowanceCents: COMMON.employeeFlatAllowanceCents,
  specialExpensesFlatCents: COMMON.specialExpensesFlatCents,
  commute: {
    value: { firstKmCents: 30, from21stKmCents: 38, capCents: 450_000 },
    source: estg(
      '9',
      '§ 9 Abs. 1 Satz 3 Nr. 4 Einkommensteuergesetz in der bis 2025 geltenden Fassung (0,30 Euro bis 20 km, 0,38 Euro ab dem 21. km, höchstens 4.500 Euro ohne eigenen Wagen)',
      '2026-10-15',
    ),
  },
  homeOfficeDay: COMMON.homeOfficeDay,
  vocationalTrainingCapCents: COMMON.vocationalTrainingCapCents,
  donationsCapBp: COMMON.donationsCapBp,
  pension: {
    // Knappschaft contribution ceiling 2025 (118,800 euros) times 24.7 percent, rounded up to the euro.
    value: { capCents: 2_934_400, deductibleBp: 10_000 },
    source: estg('10', '§ 10 Abs. 3 Einkommensteuergesetz (Höchstbeitrag knappschaftliche Rentenversicherung 2025: 29.344 Euro, ab 2023 zu 100 Prozent)', '2026-10-15'),
  },
  sickPayReductionBp: COMMON.sickPayReductionBp,
  otherInsuranceCapCents: COMMON.otherInsuranceCapCents,
  churchTaxRateBp: COMMON.churchTaxRateBp,
};

export const INCOME_TAX_RULES_2026: IncomeTaxRules = {
  year: 2026,
  reviewedOn: '2026-10-15',
  tariff: {
    value: {
      basicAllowance: 12_348,
      zone2Upper: 17_799,
      zone2: { a: 914.51, b: 1_400 },
      zone3Upper: 69_878,
      zone3: { a: 173.1, b: 2_397, c: 1_034.87 },
      zone4Upper: 277_825,
      zone4Minus: 11_135.63,
      zone5Minus: 19_470.38,
    },
    source: estg('32a', '§ 32a Abs. 1 Einkommensteuergesetz, ab dem Veranlagungszeitraum 2026', '2026-10-15'),
  },
  solidarity: {
    value: { ...COMMON.solidarityRate, exemptionLimitEuros: 20_350 },
    source: {
      citation: '§ 3 Abs. 3 Nr. 2 und § 4 Solidaritätszuschlaggesetz 1995 ab 2026 (Freigrenze 20.350 Euro, 5,5 Prozent, höchstens 11,9 Prozent des Unterschieds)',
      url: 'https://www.gesetze-im-internet.de/solzg_1995/__3.html',
      checkedOn: '2026-10-15',
    },
  },
  employeeFlatAllowanceCents: COMMON.employeeFlatAllowanceCents,
  specialExpensesFlatCents: COMMON.specialExpensesFlatCents,
  commute: {
    value: { firstKmCents: 38, from21stKmCents: 38, capCents: 450_000 },
    source: estg('9', '§ 9 Abs. 1 Satz 3 Nr. 4 Einkommensteuergesetz ab 2026 (0,38 Euro ab dem ersten km, höchstens 4.500 Euro ohne eigenen Wagen)', '2026-10-15'),
  },
  homeOfficeDay: COMMON.homeOfficeDay,
  vocationalTrainingCapCents: COMMON.vocationalTrainingCapCents,
  donationsCapBp: COMMON.donationsCapBp,
  pension: {
    // Knappschaft contribution ceiling 2026 (124,800 euros, § 4 SVBezGrV 2026) times 24.7 percent, rounded up to the euro.
    value: { capCents: 3_082_600, deductibleBp: 10_000 },
    source: {
      citation: '§ 10 Abs. 3 Einkommensteuergesetz mit § 4 Sozialversicherungsrechengrößen-Verordnung 2026 (Höchstbeitrag knappschaftliche Rentenversicherung: 30.826 Euro)',
      url: 'https://www.gesetze-im-internet.de/svbezgrv_2026/__4.html',
      checkedOn: '2026-10-15',
    },
  },
  sickPayReductionBp: COMMON.sickPayReductionBp,
  otherInsuranceCapCents: COMMON.otherInsuranceCapCents,
  churchTaxRateBp: COMMON.churchTaxRateBp,
};

const INCOME_TAX_RULE_SETS: readonly IncomeTaxRules[] = [INCOME_TAX_RULES_2025, INCOME_TAX_RULES_2026];

export const INCOME_TAX_RULE_YEARS: readonly number[] = INCOME_TAX_RULE_SETS.map((r) => r.year);

/** The values of a year; another year's, marked not exact, when the year has none (never a silent substitution). */
export function incomeTaxRulesForYear(year: number): { rules: IncomeTaxRules; exact: boolean } {
  const exact = INCOME_TAX_RULE_SETS.find((r) => r.year === year);
  if (exact) return { rules: exact, exact: true };
  const sorted = [...INCOME_TAX_RULE_SETS].sort((a, b) => a.year - b.year);
  return { rules: year > sorted[sorted.length - 1].year ? sorted[sorted.length - 1] : sorted[0], exact: false };
}
