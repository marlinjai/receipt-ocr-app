import { EUER_LABELS_BEFORE_2024, RULES_2021, SMALL_BUSINESS_LIMITS_BEFORE_2025 } from './2021';
import { ASSET_RULES_2022 } from './2022';
import { type EuerKey, employmentLines, euerLines } from './2025';
import type { Source, YearRules } from './types';

/**
 * Rule set for 2023.
 *
 * The income-surplus statement of 2023 is the shorter form, numbered one or two
 * lines below 2024 and 2025 (total of business expenses on line 72). The daily
 * home-office flat rate has no line of its own yet: it is entered on line 63
 * with the other costs of working at home. The ministry's file answered with a
 * redirect and then 503 on the check day; it was read from the Internet
 * Archive's copy of that same file (capture of 23 October 2023).
 */

export const EUER_FORM_2023: Source = {
  citation:
    'Bundesministerium der Finanzen, Schreiben vom 31. August 2023, Standardisierte Einnahmenüberschussrechnung nach § 60 Absatz 4 EStDV, Anlage EÜR 2023 (IV C 6 - S 2142/22/10002 :010)',
  url: 'https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2023-08-31-standardisierte-einnahmenueberschussrechnung-nach-paragraf-60-absatz-4-EStDV-anlage-EUER-2023.pdf?__blob=publicationFile&v=2',
  checkedOn: '2026-10-15',
};

export const EMPLOYMENT_FORM_2023: Source = {
  citation: 'Bundesministerium der Finanzen, Vordruck Anlage N 2023 (Formular-Management-System der Bundesfinanzverwaltung, 034027_23)',
  url: 'https://www.formulare-bfinv.de/ffw/catalog/openForm.do?path=catalog%3A%2F%2FSteuerformulare%2Fest%2Fest23%2F034027_23',
  checkedOn: '2026-10-15',
};

export const EUER_LINE_NUMBERS_2023: Record<EuerKey, number> = {
  'euer.revenue_small_business': 11,
  'euer.revenue_taxable': 14,
  'euer.revenue_not_taxable': 15,
  'euer.vat_received': 16,
  'euer.vat_refunded': 17,
  'euer.asset_disposal': 18,
  'euer.goods': 26,
  'euer.external_services': 27,
  'euer.depreciation_intangible': 31,
  'euer.depreciation_movable': 32,
  'euer.low_value_assets': 35,
  'euer.pool_release': 36,
  'euer.remaining_book_value': 37,
  'euer.rent_business_premises': 38,
  'euer.telecom': 41,
  'euer.travel_lodging': 42,
  'euer.training': 43,
  'euer.legal_tax_advice': 44,
  'euer.leasing_movable': 45,
  'euer.maintenance': 46,
  'euer.fees_insurance': 47,
  'euer.it_running': 48,
  'euer.work_equipment': 49,
  'euer.packaging_transport': 51,
  'euer.advertising': 52,
  'euer.input_vat': 55,
  'euer.vat_paid': 56,
  'euer.other_unlimited': 58,
  'euer.gifts': 60,
  'euer.meals': 61,
  'euer.travel_meal_allowance': 62,
  'euer.home_office_flat': 63,
  'euer.other_travel': 67,
};

const EUER_LABELS_2023: Partial<Record<EuerKey, string>> = {
  ...EUER_LABELS_BEFORE_2024,
  'euer.revenue_taxable': 'Umsatzsteuerpflichtige Betriebseinnahmen (ohne solche zum ermäßigten Steuersatz von 0 %)',
  // No line of its own: the day rate is entered here (instructions to line 63).
  'euer.home_office_flat': 'Aufwendungen für die Tätigkeit in der häuslichen Wohnung (siehe Anleitung); dort auch die Tagespauschale',
};

/**
 * Anlage N 2023 and 2024: work equipment entries on 57 and 58 with the total
 * on line 59, training costs 63, further costs entries on 65 and 66 with their
 * total on line 67 (it includes line 64).
 */
export const EMPLOYMENT_LINE_NUMBERS_2023 = {
  workEquipment: 59,
  studyCosts: 63,
  furtherCosts: {
    line: 67,
    entryNote: 'Einzeln in den Zeilen 65 und 66 eintragen; die Summe in Zeile 67 enthält auch Fähr- und Flugkosten aus Zeile 64.',
  },
};

export const RULES_2023: YearRules = {
  year: 2023,
  reviewedOn: '2026-10-15',
  formSources: { euer: EUER_FORM_2023, employment: EMPLOYMENT_FORM_2023 },
  formLines: [...euerLines(EUER_LINE_NUMBERS_2023, EUER_LABELS_2023), ...employmentLines(EMPLOYMENT_LINE_NUMBERS_2023)],
  mealDeductibleShareBp: RULES_2021.mealDeductibleShareBp,
  // The declining method stayed closed to purchases of 2023: its window of
  // 2020 to 2022 had ended and the next one opened on 1 April 2024.
  assets: ASSET_RULES_2022,
  smallBusinessLimits: SMALL_BUSINESS_LIMITS_BEFORE_2025,
};
