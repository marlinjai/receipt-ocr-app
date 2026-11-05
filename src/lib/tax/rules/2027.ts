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
 * and the amendments not yet in force, and again on 2026-11-05: the income tax
 * act was since amended on 15 October 2026 (BGBl. 2026 I Nr. 307, child benefit
 * without an application, https://www.recht.bund.de/bgbl/1/2026/307/VO.html),
 * which touches none of these values; the value-added tax act still stands as
 * amended on 29 June 2026 (BGBl. 2026 I Nr. 197). Nothing enacted changes these
 * values for 2027. Pending: the annual tax act 2026 (government bill, Bundestag
 * printed paper 21/8283), where the federal council proposed on 25 September
 * 2026 to raise the low-value limit to 1,200 euros and abolish the pool for
 * purchases after 31 December 2026; the government is examining it, and the
 * finance committee's recommendation and the Bundestag's final vote were
 * expected for 11 and 13 November 2026 (reported by Ebner Stolz, a secondary
 * source). Not law on the check day; the review after the act passes has to
 * look at `assets` first. The income tax values of 2027 (tariff, allowances)
 * live in `../income-tax/rules.ts`, provisional the same way.
 */
export const RULES_2027: YearRules = {
  year: 2027,
  reviewedOn: '2026-11-05',
  formSources: { euer: null, employment: null },
  formLines: [...euerUnnumberedLines(), ...employmentLines(null)],
  mealDeductibleShareBp: RULES_2026.mealDeductibleShareBp,
  assets: RULES_2026.assets,
  smallBusinessLimits: RULES_2026.smallBusinessLimits,
  provisional: {
    carriedFromYear: 2026,
    reason:
      'Die Anlage EÜR 2027 und die Anlage N 2027 sind noch nicht veröffentlicht. Gesetzesstand vom 5. November 2026; das Jahressteuergesetz 2026 (im Gesetzgebungsverfahren, Schlussabstimmung im Bundestag für Mitte November 2026 erwartet) könnte die Grenze für geringwertige Wirtschaftsgüter und den Sammelposten ab 2027 ändern.',
  },
};
