import { employmentLines, euerUnnumberedLines } from './2025';
import { RULES_2026 } from './2026';
import type { YearRules } from './types';

/**
 * Rule set for 2027, PROVISIONAL.
 *
 * Neither the income-surplus statement of 2027 nor the employment annex of
 * 2027 is published yet (the ministry publishes the statement in the late
 * summer of the year itself). Its lines are therefore listed by label only,
 * never with a 2026 number. The legal values are carried from 2026, where the
 * statutes as they read on the check day hold them unchanged for 2027: the
 * meal share, the asset limits (the declining method stays open for purchases
 * before 1 January 2028) and the small-business limits. `provisional` says so
 * on every surface, and a test pins each carried value, so the yearly review
 * replaces this set instead of trusting it.
 */
export const RULES_2027: YearRules = {
  year: 2027,
  reviewedOn: '2026-10-15',
  formSources: { euer: null, employment: null },
  formLines: [...euerUnnumberedLines(), ...employmentLines(null)],
  mealDeductibleShareBp: RULES_2026.mealDeductibleShareBp,
  assets: RULES_2026.assets,
  smallBusinessLimits: RULES_2026.smallBusinessLimits,
  provisional: {
    carriedFromYear: 2026,
    reason:
      'Die Anlage EÜR 2027 und die Anlage N 2027 sind noch nicht veröffentlicht. Die gesetzlichen Werte sind die von 2026, nach dem Gesetzesstand vom 15. Oktober 2026.',
  },
};
