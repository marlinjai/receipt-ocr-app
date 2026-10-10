import { ASSET_RULES_2025, SMALL_BUSINESS_LIMITS_2025, employmentLines, euerLines, type EuerKey } from './2025';
import type { Source, YearRules } from './types';

/**
 * Rule set for 2026.
 *
 * The income-surplus lines were read off the ministry's own form for 2026
 * (letter of 1 September 2026). The form was renumbered against 2025, and not
 * by one constant step: goods moved from 27 to 29, the other expense lines by
 * one, revenue lines not at all. Every number is therefore listed here on its
 * own. The employment annex of 2026 has not been compared with an official
 * source yet, so its amount lines carry no number.
 */

export const EUER_FORM_2026: Source = {
  citation:
    'Bundesministerium der Finanzen, Schreiben vom 1. September 2026, Standardisierte Einnahmenüberschussrechnung nach § 60 Absatz 4 EStDV, Anlage EÜR 2026',
  url: 'https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2026-09-01-anlage-EUER-2026.pdf?__blob=publicationFile&v=4',
  checkedOn: '2026-10-10',
};

export const EUER_LINE_NUMBERS_2026: Record<EuerKey, number> = {
  'euer.revenue_small_business': 12,
  'euer.revenue_taxable': 15,
  'euer.revenue_not_taxable': 16,
  'euer.vat_received': 17,
  'euer.vat_refunded': 18,
  'euer.asset_disposal': 19,
  'euer.goods': 29,
  'euer.external_services': 30,
  'euer.depreciation_intangible': 33,
  'euer.depreciation_movable': 34,
  'euer.low_value_assets': 37,
  'euer.pool_release': 38,
  'euer.remaining_book_value': 39,
  'euer.rent_business_premises': 40,
  'euer.telecom': 44,
  'euer.travel_lodging': 45,
  'euer.training': 46,
  'euer.legal_tax_advice': 47,
  'euer.leasing_movable': 48,
  'euer.maintenance': 49,
  'euer.fees_insurance': 50,
  'euer.it_running': 51,
  'euer.work_equipment': 52,
  'euer.packaging_transport': 54,
  'euer.advertising': 55,
  'euer.input_vat': 58,
  'euer.vat_paid': 59,
  'euer.other_unlimited': 61,
  'euer.gifts': 63,
  'euer.meals': 64,
  'euer.travel_meal_allowance': 65,
  'euer.home_office_flat': 67,
  'euer.other_travel': 71,
};

export const RULES_2026: YearRules = {
  year: 2026,
  reviewedOn: '2026-10-10',
  formSources: { euer: EUER_FORM_2026, employment: null },
  formLines: [...euerLines(EUER_LINE_NUMBERS_2026), ...employmentLines(null)],
  mealDeductibleShareBp: {
    value: 7000,
    source: {
      citation: '§ 4 Abs. 5 Satz 1 Nr. 2 Einkommensteuergesetz',
      url: 'https://www.gesetze-im-internet.de/estg/__4.html',
      checkedOn: '2026-10-07',
    },
  },
  // The asset limits and methods are unchanged for purchases of 2026 (statute
  // text checked on the days named in the sources).
  assets: ASSET_RULES_2025,
  smallBusinessLimits: SMALL_BUSINESS_LIMITS_2025,
};
