import { ASSET_RULES_2025, type EuerKey, type EuerLineOverride, employmentLines, euerLines } from './2025';
import type { AssetRules, FormLineKey, Source, YearRules } from './types';

/**
 * Rule set for 2021.
 *
 * The income-surplus statement of 2021 and 2022 is the older, longer form: the
 * numbering jumps from 31 to 41 and from 71 to 81, the total of business
 * expenses is line 88, and the daily home-office flat rate has no line of its
 * own (it is entered with the home office on line 70). The ministry's file of
 * 2021 answered 404 on the check day; it was read from the Internet Archive's
 * copy of that same file (capture of 16 October 2021), the employment annex
 * from the federal form portal.
 */

export const EUER_FORM_2021: Source = {
  citation:
    'Bundesministerium der Finanzen, Schreiben vom 31. August 2021, Standardisierte Einnahmenüberschussrechnung nach § 60 Absatz 4 EStDV, Anlage EÜR 2021 (IV C 6 - S 2142/20/10001 :011)',
  url: 'https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2021-08-31-standardisierte-einnahmenueberschussrechnung-nach-paragraf-60-absatz-4-EStDV-anlage-EUER-2021.pdf?__blob=publicationFile&v=3',
  checkedOn: '2026-10-15',
};

export const EMPLOYMENT_FORM_2021: Source = {
  citation: 'Bundesministerium der Finanzen, Vordruck Anlage N 2021 (Formular-Management-System der Bundesfinanzverwaltung, 034027_21)',
  url: 'https://www.formulare-bfinv.de/ffw/catalog/openForm.do?path=catalog%3A%2F%2FSteuerformulare%2Fest%2Fest21%2F034027_21',
  checkedOn: '2026-10-15',
};

/** Line numbers of the Anlage EÜR 2021, identical in 2022. */
export const EUER_LINE_NUMBERS_2021: Record<EuerKey, number> = {
  'euer.revenue_small_business': 11,
  'euer.revenue_taxable': 14,
  'euer.revenue_not_taxable': 15,
  'euer.vat_received': 16,
  'euer.vat_refunded': 17,
  'euer.asset_disposal': 18,
  'euer.goods': 26,
  'euer.external_services': 27,
  'euer.depreciation_intangible': 30,
  'euer.depreciation_movable': 31,
  'euer.low_value_assets': 43,
  'euer.pool_release': 44,
  'euer.remaining_book_value': 45,
  'euer.rent_business_premises': 46,
  'euer.telecom': 49,
  'euer.travel_lodging': 50,
  'euer.training': 51,
  'euer.legal_tax_advice': 52,
  'euer.leasing_movable': 53,
  'euer.maintenance': 54,
  'euer.fees_insurance': 55,
  'euer.it_running': 56,
  'euer.work_equipment': 57,
  'euer.packaging_transport': 59,
  'euer.advertising': 60,
  'euer.input_vat': 63,
  'euer.vat_paid': 64,
  'euer.other_unlimited': 66,
  'euer.gifts': 67,
  'euer.meals': 68,
  'euer.travel_meal_allowance': 69,
  'euer.home_office_flat': 70,
  'euer.other_travel': 83,
};

/** Labels the forms of 2021 to 2023 print differently from 2025. */
export const EUER_LABELS_BEFORE_2024: Partial<Record<EuerKey, EuerLineOverride>> = {
  'euer.goods': { label: 'Waren, Rohstoffe und Hilfsstoffe einschl. der Nebenkosten' },
  'euer.remaining_book_value': { label: 'Restbuchwert der ausgeschiedenen Anlagegüter' },
  'euer.leasing_movable': { label: 'Miete/Leasing für bewegliche Wirtschaftsgüter (ohne Kraftfahrzeuge)' },
  'euer.maintenance': { label: 'Erhaltungsaufwendungen (z. B. Instandhaltung, Wartung, Reparatur; ohne solche für Gebäude und Kraftfahrzeuge)' },
  'euer.fees_insurance': { label: 'Beiträge, Gebühren, Abgaben und Versicherungen (ohne solche für Gebäude und Kraftfahrzeuge)' },
  'euer.input_vat': { label: 'Gezahlte Vorsteuerbeträge' },
  'euer.other_unlimited': { label: 'Übrige unbeschränkt abziehbare Betriebsausgaben (auch zurückgezahlte Hilfen/Zuschüsse aufgrund der Corona-Pandemie)' },
};

export const EUER_LABELS_2021: Partial<Record<EuerKey, EuerLineOverride>> = {
  ...EUER_LABELS_BEFORE_2024,
  'euer.revenue_not_taxable': {
    label:
      'Umsatzsteuerfreie, nicht umsatzsteuerbare Betriebseinnahmen (auch Hilfen/Zuschüsse aufgrund der Corona-Pandemie) sowie Betriebseinnahmen, für die der Leistungsempfänger die Umsatzsteuer nach § 13b UStG schuldet',
  },
  // No line of its own: the flat rate is entered with the home office (instructions
  // to line 70), in its "abziehbar" column (field 172); the line has a "nicht
  // abziehbar" column (field 162) as well.
  'euer.home_office_flat': {
    label: 'Aufwendungen für ein häusliches Arbeitszimmer (einschl. AfA und Schuldzinsen); die Home-Office-Pauschale in die Spalte „abziehbar“ (Kennzahl 172)',
    limited: true,
  },
};

/** The employment annex of 2021 and 2022 names the home-office day count differently. */
export const EMPLOYMENT_LABELS_2021: Partial<Record<FormLineKey, string>> = {
  'employment.home_office': 'Homeoffice-Pauschale (Kalendertage, an denen die berufliche Tätigkeit ausschließlich in der häuslichen Wohnung ausgeübt wurde)',
};

/**
 * Anlage N 2021 and 2022: work equipment entries on lines 42 and 43 with the
 * total in the field on line 43, training costs 46, further costs entries on 48
 * and 49 with the total in the field on line 49 (it includes line 47).
 */
export const EMPLOYMENT_LINE_NUMBERS_2021 = {
  workEquipment: 43,
  studyCosts: 46,
  furtherCosts: {
    line: 49,
    entryNote: 'Einzeln in den Zeilen 48 und 49 eintragen; die Summe in Zeile 49 enthält auch Fähr- und Flugkosten aus Zeile 47.',
  },
};

const ESTG_7_2020_2022: AssetRules['declining'] = {
  // Purchases after 31 December 2019 and before 1 January 2023: at most two and
  // a half times the straight-line rate and at most 25 percent.
  value: { acquiredFrom: '2020-01-01', acquiredTo: '2022-12-31', maxRateBp: 2500, maxMultipleOfLinear: 2.5 },
  source: {
    citation: '§ 7 Abs. 2 Einkommensteuergesetz in der Fassung des Zweiten Corona-Steuerhilfegesetzes (Fassung vom März 2024)',
    url: 'https://web.archive.org/web/20240304192020/https://www.gesetze-im-internet.de/estg/__7.html',
    checkedOn: '2026-10-15',
  },
};

/**
 * The limits of section 19 before 2025: 22,000 and 50,000 euros, turnover with
 * the tax on it. The 50,000 was a forecast made at the start of the year: going
 * over it during the year did not end the rule in that year.
 */
export const SMALL_BUSINESS_LIMITS_BEFORE_2025: YearRules['smallBusinessLimits'] = {
  value: { previousYearLimitCents: 2_200_000, currentYearLimitCents: 5_000_000, currentYearLimit: 'forecast_at_start' },
  source: {
    citation: '§ 19 Abs. 1 Umsatzsteuergesetz in der bis 31. Dezember 2024 geltenden Fassung (Umsatz zuzüglich der darauf entfallenden Steuer)',
    url: 'https://web.archive.org/web/20240531000000/https://www.gesetze-im-internet.de/ustg_1980/__19.html',
    checkedOn: '2026-10-15',
  },
};

export const ASSET_RULES_2021: AssetRules = {
  ...ASSET_RULES_2025,
  computer: {
    value: { usefulLifeMonths: 12, fullAmountInFirstYear: true },
    source: {
      citation:
        'Bundesministerium der Finanzen, Schreiben vom 26. Februar 2021, Nutzungsdauer von Computerhardware und Software zur Dateneingabe und -verarbeitung (IV C 3 - S 2190/21/10002 :013), BStBl I 2021 S. 298',
      url: 'https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2021-02-26-nutzungsdauer-von-computerhardware-und-software-zur-dateneingabe-und-verarbeitung.pdf?__blob=publicationFile&v=2',
      checkedOn: '2026-10-15',
    },
  },
  declining: ESTG_7_2020_2022,
};

export const RULES_2021: YearRules = {
  year: 2021,
  reviewedOn: '2026-10-15',
  formSources: { euer: EUER_FORM_2021, employment: EMPLOYMENT_FORM_2021 },
  formLines: [...euerLines(EUER_LINE_NUMBERS_2021, EUER_LABELS_2021), ...employmentLines(EMPLOYMENT_LINE_NUMBERS_2021, EMPLOYMENT_LABELS_2021)],
  mealDeductibleShareBp: {
    value: 7000,
    source: {
      citation: '§ 4 Abs. 5 Satz 1 Nr. 2 Einkommensteuergesetz',
      url: 'https://www.gesetze-im-internet.de/estg/__4.html',
      checkedOn: '2026-10-15',
    },
  },
  assets: ASSET_RULES_2021,
  smallBusinessLimits: SMALL_BUSINESS_LIMITS_BEFORE_2025,
};
