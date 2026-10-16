import {
  ASSET_RULES_2021,
  EMPLOYMENT_LABELS_2021,
  EMPLOYMENT_LINE_NUMBERS_2021,
  EUER_LABELS_2021,
  EUER_LINE_NUMBERS_2021,
  RULES_2021,
  SMALL_BUSINESS_LIMITS_BEFORE_2025,
} from './2021';
import { ASSET_RULES_2025, employmentLines, euerLines } from './2025';
import type { AssetRules, Source, YearRules } from './types';

/**
 * Rule set for 2022.
 *
 * The income-surplus statement of 2022 has the numbering and the labels of
 * 2021, line for line (both forms were read separately). The ministry's file
 * answered with a redirect and then 503 on the check day; it was read from the
 * Internet Archive's copy of that same file (capture of 3 September 2022).
 */

export const EUER_FORM_2022: Source = {
  citation:
    'Bundesministerium der Finanzen, Schreiben vom 1. September 2022, Standardisierte Einnahmenüberschussrechnung nach § 60 Absatz 4 EStDV, Anlage EÜR 2022 (IV C 6 - S 2142/21/10002 :010)',
  url: 'https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2022-09-01-standardisierte-einnahmenueberschussrechnung-nach-paragraf-60-absatz-4-EStDV-anlage-EUER-2022.pdf?__blob=publicationFile&v=3',
  checkedOn: '2026-10-15',
};

export const EMPLOYMENT_FORM_2022: Source = {
  citation: 'Bundesministerium der Finanzen, Vordruck Anlage N 2022 (Formular-Management-System der Bundesfinanzverwaltung, 034027_22)',
  url: 'https://www.formulare-bfinv.de/ffw/catalog/openForm.do?path=catalog%3A%2F%2FSteuerformulare%2Fest%2Fest22%2F034027_22',
  checkedOn: '2026-10-15',
};

/**
 * The letter of 22 February 2022 replaced the one of 26 February 2021 and is
 * the one 2025 cites as well; the declining window of 2020 to 2022 still holds.
 */
export const ASSET_RULES_2022: AssetRules = {
  ...ASSET_RULES_2021,
  computer: ASSET_RULES_2025.computer,
};

export const RULES_2022: YearRules = {
  year: 2022,
  reviewedOn: '2026-10-15',
  formSources: { euer: EUER_FORM_2022, employment: EMPLOYMENT_FORM_2022 },
  formLines: [...euerLines(EUER_LINE_NUMBERS_2021, EUER_LABELS_2021), ...employmentLines(EMPLOYMENT_LINE_NUMBERS_2021, EMPLOYMENT_LABELS_2021)],
  mealDeductibleShareBp: RULES_2021.mealDeductibleShareBp,
  assets: ASSET_RULES_2022,
  smallBusinessLimits: SMALL_BUSINESS_LIMITS_BEFORE_2025,
};
