import { RULES_2021, SMALL_BUSINESS_LIMITS_BEFORE_2025 } from './2021';
import { EMPLOYMENT_LINE_NUMBERS_2023 } from './2023';
import { ASSET_RULES_2025, EUER_LABELS_2023_2025, EUER_LINE_NUMBERS_2025, employmentLines, euerLines } from './2025';
import type { AssetRules, Source, YearRules } from './types';

/**
 * Rule set for 2024.
 *
 * The income-surplus statement of 2024 has every line on the same number as
 * 2025 (total of business expenses on line 75), and the same labels except the
 * reference to section 4 on the tax-free revenue line, which 2025 added. The
 * employment annex of 2024 is laid out like 2023's. The ministry's file
 * answered 503 on the check day; it was read from the Internet Archive's copy
 * of that same file (capture of 2 December 2024).
 */

export const EUER_FORM_2024: Source = {
  citation:
    'Bundesministerium der Finanzen, Schreiben vom 2. September 2024, Standardisierte Einnahmenüberschussrechnung nach § 60 Absatz 4 EStDV, Anlage EÜR 2024 (IV C 6 - S 2142/23/10001 :010)',
  url: 'https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2024-09-02-anlage-EUER-2024.pdf?__blob=publicationFile&v=5',
  checkedOn: '2026-10-15',
};

export const EMPLOYMENT_FORM_2024: Source = {
  citation: 'Bundesministerium der Finanzen, Vordruck Anlage N 2024 (Formular-Management-System der Bundesfinanzverwaltung, 034027_24)',
  url: 'https://www.formulare-bfinv.de/ffw/catalog/openForm.do?path=catalog%3A%2F%2FSteuerformulare%2Fest%2Fest24%2F034027_24',
  checkedOn: '2026-10-15',
};

/**
 * The declining method reopened for purchases after 31 March 2024 and before
 * 1 January 2025, at most twice the straight-line rate and at most 20 percent.
 */
export const ASSET_RULES_2024: AssetRules = {
  ...ASSET_RULES_2025,
  declining: {
    value: { acquiredFrom: '2024-04-01', acquiredTo: '2024-12-31', maxRateBp: 2000, maxMultipleOfLinear: 2 },
    source: {
      citation: '§ 7 Abs. 2 Einkommensteuergesetz in der Fassung des Wachstumschancengesetzes vom 27. März 2024 (BGBl. 2024 I Nr. 108, Artikel 3 Nummer 2)',
      url: 'https://www.recht.bund.de/bgbl/1/2024/108/regelungstext.pdf',
      checkedOn: '2026-10-15',
    },
  },
};

export const RULES_2024: YearRules = {
  year: 2024,
  reviewedOn: '2026-10-15',
  formSources: { euer: EUER_FORM_2024, employment: EMPLOYMENT_FORM_2024 },
  formLines: [...euerLines(EUER_LINE_NUMBERS_2025, EUER_LABELS_2023_2025), ...employmentLines(EMPLOYMENT_LINE_NUMBERS_2023)],
  mealDeductibleShareBp: RULES_2021.mealDeductibleShareBp,
  assets: ASSET_RULES_2024,
  smallBusinessLimits: SMALL_BUSINESS_LIMITS_BEFORE_2025,
};
