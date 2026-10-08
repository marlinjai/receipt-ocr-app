import { EUER_FORM_2025, FORM_LINES_2025 } from './2025';
import type { YearRules } from './types';

/**
 * Rule set for 2026.
 *
 * The finance ministry published the Anlage EÜR 2026 with its letter of
 * 1 September 2026. Its line numbers have NOT been compared with that form
 * yet: this catalog carries the 2025 numbers and says so
 * (`formLinesVerified: false`), so the app prints the labels and marks the
 * numbers as unverified instead of presenting last year's numbers as this
 * year's. Comparing them is part of building the year-end entry sheet.
 */
export const RULES_2026: YearRules = {
  year: 2026,
  reviewedOn: '2026-10-07',
  formLinesSource: EUER_FORM_2025,
  formLinesVerified: false,
  formLines: FORM_LINES_2025,
  mealDeductibleShareBp: {
    value: 7000,
    source: {
      citation: '§ 4 Abs. 5 Satz 1 Nr. 2 Einkommensteuergesetz',
      url: 'https://www.gesetze-im-internet.de/estg/__4.html',
      checkedOn: '2026-10-07',
    },
  },
};
