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
 *
 * Checked on 2026-10-15 against the statutes as last amended on 29 June 2026
 * and the amendments not yet in force: nothing enacted changes these values for
 * 2027. Pending: the annual tax act 2026 (government bill, Bundestag printed
 * paper 21/8283), where the federal council proposed on 25 September 2026 to
 * raise the low-value limit to 1,200 euros and abolish the pool for purchases
 * after 31 December 2026. Not law on the check day; the review after the act
 * passes has to look at `assets` first.
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
      'Die Anlage EÜR 2027 und die Anlage N 2027 sind noch nicht veröffentlicht. Die gesetzlichen Werte sind die von 2026, nach dem Gesetzesstand vom 15. Oktober 2026; das Jahressteuergesetz 2026 (im Gesetzgebungsverfahren) könnte die Grenzen für geringwertige Wirtschaftsgüter ab 2027 ändern.',
  },
};
