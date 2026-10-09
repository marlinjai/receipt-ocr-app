import type { AssetRules, FormLine, FormLineKey, Source, YearRules } from './types';

/**
 * Rule set for 2025.
 *
 * The income-surplus lines were read off the ministry's own form (letter of
 * 29 August 2025, file reference IV C 6 - S 2142/00023/010/001). The employment
 * annex lines come from the tax portal's official help for the 2025 return.
 */

export const EUER_FORM_2025: Source = {
  citation:
    'Bundesministerium der Finanzen, Schreiben vom 29. August 2025, Standardisierte Einnahmenüberschussrechnung nach § 60 Absatz 4 EStDV, Anlage EÜR 2025 (IV C 6 - S 2142/00023/010/001)',
  url: 'https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-08-29-anlage-EUER-2025.pdf?__blob=publicationFile&v=4',
  checkedOn: '2026-10-10',
};

export const EMPLOYMENT_FORM_2025: Source = {
  citation: 'ELSTER, Hilfe zur Einkommensteuererklärung 2025, Anlage N (Werbungskosten)',
  url: 'https://www.elster.de/elsterweb/helpGlobal?themaGlobal=help_est_ufa_10_2025',
  checkedOn: '2026-10-10',
};

/** The labels of the income-surplus statement, shared by the years; the line numbers are per year. */
export const EUER_LABELS: Record<Extract<FormLineKey, `euer.${string}`>, { label: string; kind: 'revenue' | 'expense'; limited?: boolean; assetOnly?: boolean }> = {
  'euer.revenue_small_business': { label: 'Betriebseinnahmen als umsatzsteuerlicher Kleinunternehmer (nach § 19 Abs. 1 UStG)', kind: 'revenue' },
  'euer.revenue_taxable': { label: 'Umsatzsteuerpflichtige Betriebseinnahmen', kind: 'revenue' },
  'euer.revenue_not_taxable': {
    label: 'Betriebseinnahmen, die umsatzsteuerfrei oder nicht umsatzsteuerbar sind oder für die der Leistungsempfänger die Umsatzsteuer nach § 13b UStG schuldet',
    kind: 'revenue',
  },
  'euer.vat_received': { label: 'Vereinnahmte Umsatzsteuer sowie Umsatzsteuer auf unentgeltliche Wertabgaben', kind: 'revenue' },
  'euer.vat_refunded': { label: 'Vom Finanzamt erstattete und ggf. verrechnete Umsatzsteuer', kind: 'revenue' },
  'euer.asset_disposal': { label: 'Veräußerung oder Entnahme von Anlagevermögen', kind: 'revenue', assetOnly: true },
  'euer.goods': { label: 'Waren, Rohstoffe und Hilfsstoffe einschließlich der Nebenkosten', kind: 'expense' },
  'euer.external_services': { label: 'Bezogene Fremdleistungen', kind: 'expense' },
  'euer.depreciation_intangible': { label: 'AfA auf immaterielle Wirtschaftsgüter', kind: 'expense', assetOnly: true },
  'euer.depreciation_movable': { label: 'AfA auf bewegliche Wirtschaftsgüter', kind: 'expense', assetOnly: true },
  'euer.low_value_assets': { label: 'Aufwendungen für geringwertige Wirtschaftsgüter nach § 6 Abs. 2 EStG', kind: 'expense' },
  'euer.pool_release': { label: 'Auflösung Sammelposten nach § 6 Abs. 2a EStG', kind: 'expense', assetOnly: true },
  'euer.remaining_book_value': { label: 'Restbuchwerte der ausgeschiedenen Anlagegüter', kind: 'expense', assetOnly: true },
  'euer.rent_business_premises': { label: 'Miete/Pacht für Geschäftsräume und betrieblich genutzte Grundstücke', kind: 'expense' },
  'euer.telecom': { label: 'Aufwendungen für Telekommunikation (z. B. Telefon, Internet)', kind: 'expense' },
  'euer.travel_lodging': { label: 'Übernachtungs- und Reisenebenkosten bei Geschäftsreisen des Steuerpflichtigen', kind: 'expense' },
  'euer.training': { label: 'Fortbildungskosten (ohne Reisekosten)', kind: 'expense' },
  'euer.legal_tax_advice': { label: 'Kosten für Rechts- und Steuerberatung, Buchführung', kind: 'expense' },
  'euer.leasing_movable': { label: 'Miete/Leasing für bewegliche Wirtschaftsgüter (ohne Kfz)', kind: 'expense' },
  'euer.maintenance': { label: 'Erhaltungsaufwendungen (z. B. Instandhaltung, Wartung, Reparatur; ohne solche für Gebäude und Kfz)', kind: 'expense' },
  'euer.fees_insurance': { label: 'Beiträge, Gebühren, Abgaben und Versicherungen (ohne solche für Gebäude und Kfz)', kind: 'expense' },
  'euer.it_running': { label: 'Laufende EDV-Kosten (z. B. Beratung, Wartung, Reparatur)', kind: 'expense' },
  'euer.work_equipment': { label: 'Arbeitsmittel (z. B. Bürobedarf, Porto, Fachliteratur)', kind: 'expense' },
  'euer.packaging_transport': { label: 'Kosten für Verpackung und Transport', kind: 'expense' },
  'euer.advertising': { label: 'Werbekosten (z. B. Inserate, Werbespots, Plakate)', kind: 'expense' },
  'euer.input_vat': { label: 'Gezahlte und nach § 15 UStG abziehbare Vorsteuerbeträge', kind: 'expense' },
  'euer.vat_paid': { label: 'An das Finanzamt gezahlte und ggf. verrechnete Umsatzsteuer', kind: 'expense' },
  'euer.other_unlimited': { label: 'Übrige unbeschränkt abziehbare Betriebsausgaben', kind: 'expense' },
  'euer.gifts': { label: 'Geschenke', kind: 'expense', limited: true },
  'euer.meals': { label: 'Bewirtungsaufwendungen', kind: 'expense', limited: true },
  'euer.travel_meal_allowance': { label: 'Verpflegungsmehraufwendungen', kind: 'expense' },
  'euer.home_office_flat': { label: 'Tagespauschale für die Tätigkeit in der häuslichen Wohnung', kind: 'expense' },
  'euer.other_travel': {
    label:
      'Sonstige tatsächliche Fahrtkosten ohne AfA und Zinsen (z. B. Reparaturen, Wartungen, Treibstoff, Kosten für Flugstrecken, Kosten für öffentliche Verkehrsmittel)',
    kind: 'expense',
  },
};

export type EuerKey = keyof typeof EUER_LABELS;

/**
 * Build the income-surplus part of a year's catalog from that year's own
 * line numbers. Every key has to be listed: a year never inherits a number
 * from another year, because the form is renumbered between years and not by
 * a constant offset.
 */
export function euerLines(numbers: Record<EuerKey, number>): FormLine[] {
  return (Object.keys(EUER_LABELS) as EuerKey[])
    .map((key) => ({ key, form: 'euer' as const, line: numbers[key], numbering: 'verified' as const, ...EUER_LABELS[key] }))
    .sort((a, b) => a.line - b.line);
}

/** Line numbers of the Anlage EÜR 2025, read off the ministry's form. */
export const EUER_LINE_NUMBERS_2025: Record<EuerKey, number> = {
  'euer.revenue_small_business': 12,
  'euer.revenue_taxable': 15,
  'euer.revenue_not_taxable': 16,
  'euer.vat_received': 17,
  'euer.vat_refunded': 18,
  'euer.asset_disposal': 19,
  'euer.goods': 27,
  'euer.external_services': 29,
  'euer.depreciation_intangible': 32,
  'euer.depreciation_movable': 33,
  'euer.low_value_assets': 36,
  'euer.pool_release': 37,
  'euer.remaining_book_value': 38,
  'euer.rent_business_premises': 39,
  'euer.telecom': 43,
  'euer.travel_lodging': 44,
  'euer.training': 45,
  'euer.legal_tax_advice': 46,
  'euer.leasing_movable': 47,
  'euer.maintenance': 48,
  'euer.fees_insurance': 49,
  'euer.it_running': 50,
  'euer.work_equipment': 51,
  'euer.packaging_transport': 53,
  'euer.advertising': 54,
  'euer.input_vat': 57,
  'euer.vat_paid': 58,
  'euer.other_unlimited': 60,
  'euer.gifts': 62,
  'euer.meals': 63,
  'euer.travel_meal_allowance': 64,
  'euer.home_office_flat': 66,
  'euer.other_travel': 70,
};

const EMPLOYMENT_LABELS = {
  'employment.work_equipment': 'Aufwendungen für Arbeitsmittel',
  'employment.study_costs': 'Fortbildungskosten',
  'employment.commute': 'Wege zwischen Wohnung und erster Tätigkeitsstätte (Entfernungspauschale)',
  'employment.home_office': 'Tagespauschale für die Tätigkeit in der häuslichen Wohnung',
} as const;

/** The two employment lines the form has no amount field for, in every year. */
const STRUCTURED_EMPLOYMENT: FormLine[] = [
  {
    key: 'employment.commute',
    form: 'employment',
    line: null,
    numbering: 'structured',
    structuredNote: 'Das Formular fragt Entfernung, Tage und Verkehrsmittel je Tätigkeitsstätte ab; es gibt kein Feld für einen Gesamtbetrag.',
    label: EMPLOYMENT_LABELS['employment.commute'],
    kind: 'expense',
  },
  {
    key: 'employment.home_office',
    form: 'employment',
    line: null,
    numbering: 'structured',
    structuredNote: 'Das Formular fragt die Anzahl der Tage ab, keinen Betrag.',
    label: EMPLOYMENT_LABELS['employment.home_office'],
    kind: 'expense',
  },
];

/**
 * The employment annex part of a catalog. `numbers` null: the annex of that
 * year has not been compared with an official source, so its amount lines
 * carry no number (never another year's).
 */
export function employmentLines(numbers: { workEquipment: number; studyCosts: number } | null): FormLine[] {
  const amount = (key: 'employment.work_equipment' | 'employment.study_costs', line: number | null): FormLine => ({
    key,
    form: 'employment',
    line,
    numbering: line === null ? 'unverified' : 'verified',
    label: EMPLOYMENT_LABELS[key],
    kind: 'expense',
  });
  return [
    amount('employment.work_equipment', numbers?.workEquipment ?? null),
    amount('employment.study_costs', numbers?.studyCosts ?? null),
    ...STRUCTURED_EMPLOYMENT,
  ];
}

export const FORM_LINES_2025: readonly FormLine[] = [
  ...euerLines(EUER_LINE_NUMBERS_2025),
  // Anlage N 2025: work equipment is entered on lines 54 to 56 with the total on
  // 56; training costs on line 60.
  ...employmentLines({ workEquipment: 56, studyCosts: 60 }),
];

const ESTG_6: Source = {
  citation: '§ 6 Abs. 2 und 2a Einkommensteuergesetz',
  url: 'https://www.gesetze-im-internet.de/estg/__6.html',
  checkedOn: '2026-10-07',
};

/**
 * Asset rules for purchases of 2025. The declining-balance method was reopened
 * for movable assets bought after 30 June 2025 and before 1 January 2028, so it
 * is one value with its own dates rather than a yes or no per year.
 */
export const ASSET_RULES_2025: AssetRules = {
  lowValueNetLimitCents: { value: 80_000, source: ESTG_6 },
  lowValueRegisterAboveNetCents: { value: 25_000, source: ESTG_6 },
  pool: { value: { minExclusiveNetCents: 25_000, maxNetCents: 100_000, years: 5 }, source: ESTG_6 },
  computer: {
    value: { usefulLifeMonths: 12, fullAmountInFirstYear: true },
    source: {
      citation:
        'Bundesministerium der Finanzen, Schreiben vom 22. Februar 2022, Nutzungsdauer von Computerhardware und Software zur Dateneingabe und -verarbeitung (IV C 3 - S 2190/21/10002 :025)',
      url: 'https://www.ihk.de/blueprint/servlet/resource/blob/5503784/477169aa20e2f5afe493340680db64dc/bmf-schreiben-2022-0222-data.pdf',
      checkedOn: '2026-10-07',
    },
  },
  declining: {
    value: { acquiredFrom: '2025-07-01', acquiredTo: '2027-12-31', maxRateBp: 3000, maxMultipleOfLinear: 3 },
    source: {
      citation: '§ 7 Abs. 2 Einkommensteuergesetz',
      url: 'https://www.gesetze-im-internet.de/estg/__7.html',
      checkedOn: '2026-10-07',
    },
  },
  highestVatRateBp: {
    value: 1900,
    source: {
      citation: '§ 12 Abs. 1 Umsatzsteuergesetz',
      url: 'https://www.gesetze-im-internet.de/ustg_1980/__12.html',
      checkedOn: '2026-10-07',
    },
  },
};

/** The limits in force since 1 January 2025. */
export const SMALL_BUSINESS_LIMITS_2025: YearRules['smallBusinessLimits'] = {
  value: { previousYearLimitCents: 2_500_000, currentYearLimitCents: 10_000_000 },
  source: {
    citation: '§ 19 Abs. 1 und 2 Umsatzsteuergesetz',
    url: 'https://www.gesetze-im-internet.de/ustg_1980/__19.html',
    checkedOn: '2026-10-10',
  },
};

export const RULES_2025: YearRules = {
  year: 2025,
  reviewedOn: '2026-10-07',
  formSources: { euer: EUER_FORM_2025, employment: EMPLOYMENT_FORM_2025 },
  formLines: FORM_LINES_2025,
  mealDeductibleShareBp: {
    value: 7000,
    source: {
      citation: '§ 4 Abs. 5 Satz 1 Nr. 2 Einkommensteuergesetz',
      url: 'https://www.gesetze-im-internet.de/estg/__4.html',
      checkedOn: '2026-10-07',
    },
  },
  assets: ASSET_RULES_2025,
  smallBusinessLimits: SMALL_BUSINESS_LIMITS_2025,
};
