import type { AssetRules, FormLine, Source, YearRules } from './types';

/**
 * Rule set for 2025.
 *
 * The form line catalog was read off the official form: the finance
 * ministry's letter of 29 August 2025 that publishes the Anlage EÜR 2025
 * (file reference IV C 6 - S 2142/00023/010/001). Line numbers of the
 * employment annex (Anlage N) are not entered yet; they are compared with the
 * official form when the year-end entry sheet is built.
 */

export const EUER_FORM_2025: Source = {
  citation:
    'Bundesministerium der Finanzen, Schreiben vom 29. August 2025, Standardisierte Einnahmenüberschussrechnung nach § 60 Absatz 4 EStDV, Anlage EÜR 2025 (IV C 6 - S 2142/00023/010/001)',
  // The copy of the letter and its forms that the line numbers were read from.
  url: 'https://www.steuerschroeder.de/blog/wp-content/uploads/2025/09/2025-08-29-anlage-EUER-2025.pdf',
  checkedOn: '2026-10-07',
};

export const FORM_LINES_2025: readonly FormLine[] = [
  {
    key: 'euer.revenue_small_business',
    form: 'euer',
    line: 12,
    label: 'Betriebseinnahmen als umsatzsteuerlicher Kleinunternehmer (nach § 19 Abs. 1 UStG)',
    kind: 'revenue',
  },
  {
    key: 'euer.asset_disposal',
    form: 'euer',
    line: 19,
    label: 'Veräußerung oder Entnahme von Anlagevermögen',
    kind: 'revenue',
    assetOnly: true,
  },
  { key: 'euer.goods', form: 'euer', line: 27, label: 'Waren, Rohstoffe und Hilfsstoffe einschließlich der Nebenkosten', kind: 'expense' },
  { key: 'euer.external_services', form: 'euer', line: 29, label: 'Bezogene Fremdleistungen', kind: 'expense' },
  { key: 'euer.depreciation_intangible', form: 'euer', line: 32, label: 'AfA auf immaterielle Wirtschaftsgüter', kind: 'expense', assetOnly: true },
  { key: 'euer.depreciation_movable', form: 'euer', line: 33, label: 'AfA auf bewegliche Wirtschaftsgüter', kind: 'expense', assetOnly: true },
  {
    key: 'euer.low_value_assets',
    form: 'euer',
    line: 36,
    label: 'Aufwendungen für geringwertige Wirtschaftsgüter nach § 6 Abs. 2 EStG',
    kind: 'expense',
  },
  { key: 'euer.pool_release', form: 'euer', line: 37, label: 'Auflösung Sammelposten nach § 6 Abs. 2a EStG', kind: 'expense', assetOnly: true },
  { key: 'euer.remaining_book_value', form: 'euer', line: 38, label: 'Restbuchwerte der ausgeschiedenen Anlagegüter', kind: 'expense', assetOnly: true },
  {
    key: 'euer.rent_business_premises',
    form: 'euer',
    line: 39,
    label: 'Miete/Pacht für Geschäftsräume und betrieblich genutzte Grundstücke',
    kind: 'expense',
  },
  { key: 'euer.telecom', form: 'euer', line: 43, label: 'Aufwendungen für Telekommunikation (z. B. Telefon, Internet)', kind: 'expense' },
  {
    key: 'euer.travel_lodging',
    form: 'euer',
    line: 44,
    label: 'Übernachtungs- und Reisenebenkosten bei Geschäftsreisen des Steuerpflichtigen',
    kind: 'expense',
  },
  { key: 'euer.training', form: 'euer', line: 45, label: 'Fortbildungskosten (ohne Reisekosten)', kind: 'expense' },
  { key: 'euer.legal_tax_advice', form: 'euer', line: 46, label: 'Kosten für Rechts- und Steuerberatung, Buchführung', kind: 'expense' },
  { key: 'euer.leasing_movable', form: 'euer', line: 47, label: 'Miete/Leasing für bewegliche Wirtschaftsgüter (ohne Kfz)', kind: 'expense' },
  {
    key: 'euer.maintenance',
    form: 'euer',
    line: 48,
    label: 'Erhaltungsaufwendungen (z. B. Instandhaltung, Wartung, Reparatur; ohne solche für Gebäude und Kfz)',
    kind: 'expense',
  },
  {
    key: 'euer.fees_insurance',
    form: 'euer',
    line: 49,
    label: 'Beiträge, Gebühren, Abgaben und Versicherungen (ohne solche für Gebäude und Kfz)',
    kind: 'expense',
  },
  { key: 'euer.it_running', form: 'euer', line: 50, label: 'Laufende EDV-Kosten (z. B. Beratung, Wartung, Reparatur)', kind: 'expense' },
  { key: 'euer.work_equipment', form: 'euer', line: 51, label: 'Arbeitsmittel (z. B. Bürobedarf, Porto, Fachliteratur)', kind: 'expense' },
  { key: 'euer.packaging_transport', form: 'euer', line: 53, label: 'Kosten für Verpackung und Transport', kind: 'expense' },
  { key: 'euer.advertising', form: 'euer', line: 54, label: 'Werbekosten (z. B. Inserate, Werbespots, Plakate)', kind: 'expense' },
  { key: 'euer.other_unlimited', form: 'euer', line: 60, label: 'Übrige unbeschränkt abziehbare Betriebsausgaben', kind: 'expense' },
  { key: 'euer.gifts', form: 'euer', line: 62, label: 'Geschenke', kind: 'expense', limited: true },
  { key: 'euer.meals', form: 'euer', line: 63, label: 'Bewirtungsaufwendungen', kind: 'expense', limited: true },
  { key: 'euer.travel_meal_allowance', form: 'euer', line: 64, label: 'Verpflegungsmehraufwendungen', kind: 'expense' },
  {
    key: 'euer.home_office_flat',
    form: 'euer',
    line: 66,
    label: 'Tagespauschale für die Tätigkeit in der häuslichen Wohnung',
    kind: 'expense',
  },
  {
    key: 'euer.other_travel',
    form: 'euer',
    line: 70,
    label:
      'Sonstige tatsächliche Fahrtkosten ohne AfA und Zinsen (z. B. Reparaturen, Wartungen, Treibstoff, Kosten für Flugstrecken, Kosten für öffentliche Verkehrsmittel)',
    kind: 'expense',
  },
  { key: 'employment.work_equipment', form: 'employment', line: null, label: 'Aufwendungen für Arbeitsmittel', kind: 'expense' },
  { key: 'employment.study_costs', form: 'employment', line: null, label: 'Fortbildungskosten', kind: 'expense' },
  {
    key: 'employment.commute',
    form: 'employment',
    line: null,
    label: 'Wege zwischen Wohnung und erster Tätigkeitsstätte (Entfernungspauschale)',
    kind: 'expense',
  },
  { key: 'employment.home_office', form: 'employment', line: null, label: 'Tagespauschale für die Tätigkeit in der häuslichen Wohnung', kind: 'expense' },
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

export const RULES_2025: YearRules = {
  year: 2025,
  reviewedOn: '2026-10-07',
  formLinesSource: EUER_FORM_2025,
  formLinesVerified: true,
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
};
