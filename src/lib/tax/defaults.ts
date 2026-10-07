import type { FormLineKey } from './rules/types';
import type { Allocation } from './types';

/**
 * What an item is taken to be when nobody has decided anything about it yet.
 * A default is only ever a starting point shown as such; a vendor rule or a
 * decision on the item replaces it.
 */

/**
 * The statement line a receipt category goes to by default. Hardware lands on
 * the low-value asset line until the asset register decides (above the limit
 * it becomes an asset with a schedule). A category missing here has no default
 * and asks for a decision.
 */
export const CATEGORY_FORM_LINE: Record<string, FormLineKey> = {
  Bewirtung: 'euer.meals',
  Reisekosten: 'euer.travel_lodging',
  Bürobedarf: 'euer.work_equipment',
  'Software & Lizenzen': 'euer.work_equipment',
  'Telefon & Internet': 'euer.telecom',
  'Hardware & IT': 'euer.low_value_assets',
  'Miete & Nebenkosten': 'euer.rent_business_premises',
  Versicherungen: 'euer.fees_insurance',
  Fachliteratur: 'euer.work_equipment',
  'Sonstige Ausgaben': 'euer.other_unlimited',
};

/** The employment annex line a study or employment share goes to unless decided otherwise. */
export const DEFAULT_STUDY_LINE: FormLineKey = 'employment.study_costs';
export const DEFAULT_EMPLOYMENT_LINE: FormLineKey = 'employment.work_equipment';

/**
 * The allocation implied by the two older receipt columns, "Zuordnung"
 * (assignment: business, university, private) and "Business Share %". They
 * can express one purpose and one share, which is why allocations exist; until
 * an item or its vendor has a real decision they are read as a starting point.
 *
 * No assignment means nobody has said who bears the item: null, an open check.
 */
export function legacyAllocations(zuordnung: string | null, businessSharePercent: number | null): Allocation[] | null {
  const percent =
    businessSharePercent === null || !Number.isFinite(businessSharePercent)
      ? 100
      : Math.min(100, Math.max(0, businessSharePercent));
  const shareBp = Math.round(percent * 100);
  switch (zuordnung) {
    case 'Geschäftlich':
      return shareBp > 0 ? [{ purpose: 'business', shareBp }] : [{ purpose: 'private', shareBp: 10000 }];
    case 'Universität':
      return shareBp > 0 ? [{ purpose: 'study', shareBp }] : [{ purpose: 'private', shareBp: 10000 }];
    case 'Privat':
      return [{ purpose: 'private', shareBp: 10000 }];
    default:
      return null;
  }
}
