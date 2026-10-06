import type { MealRecord, MealTaxSettings } from '../types';

/** Obviously fictional people and places; never real names in fixtures. */
export const GUEST_A = { contactId: 'c-1', name: 'Erika Beispiel', company: 'Beispiel GmbH' };
export const GUEST_B = { contactId: 'c-2', name: 'Max Muster', company: 'Muster AG' };

export const SMALL_BUSINESS: MealTaxSettings = { smallBusiness: true, hostAddressThresholdEur: 250 };
export const REGULAR_BUSINESS: MealTaxSettings = { smallBusiness: false, hostAddressThresholdEur: 250 };
export const UNANSWERED: MealTaxSettings = { smallBusiness: null, hostAddressThresholdEur: 250 };

/** A complete external business meal; override single facts per test. */
export function meal(overrides: Partial<MealRecord> = {}): MealRecord {
  return {
    rowId: 'row-1',
    name: 'Mittagessen Testlokal',
    vendor: 'Testlokal',
    date: '2025-03-14',
    category: 'Bewirtung',
    zuordnung: 'Geschäftlich',
    mealType: 'business_meal_external',
    gross: 119,
    net: 100,
    taxRate: 19,
    currency: 'EUR',
    fxRate: 1,
    occasion: 'Abstimmung Relaunch Webshop, Angebot Phase 2',
    place: 'Testlokal, Musterstraße 1, 12345 Musterstadt',
    host: 'Inhaber Beispiel',
    tip: 11,
    consumption: 'dine_in',
    taxLines: null,
    detailsAt: '2025-03-15T09:00:00.000Z',
    confidence: 95,
    guests: [GUEST_A],
    files: [],
    ...overrides,
  };
}
