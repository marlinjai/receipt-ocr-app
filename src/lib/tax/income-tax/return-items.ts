/**
 * Other items of the income tax return, entered per year: days and distances
 * the employment annex asks for, special expenses, insurance contributions
 * not on a wage statement, and advance payments. Each item is one stated
 * fact with an optional note on its evidence; several items of one kind are
 * added up (two union dues payments, two places of study).
 */

export type ReturnItemMeasure = 'amount' | 'days' | 'commute';

export interface ReturnItemKind {
  key: ReturnItemKey;
  /** German label as the form or the owner would say it. */
  label: string;
  /** Where it goes. */
  group: 'employment' | 'special' | 'insurance' | 'prepayment';
  measure: ReturnItemMeasure;
  /** One sentence on what belongs here. */
  hint: string;
}

export const RETURN_ITEM_KEYS = [
  'employment.home_office_days',
  'employment.commute',
  'employment.union_dues',
  'employment.other',
  'special.vocational_training',
  'special.donations',
  'special.church_tax_paid',
  'special.church_tax_refunded',
  'insurance.pension_self_paid',
  'insurance.health_self_paid_sick_pay',
  'insurance.health_self_paid',
  'insurance.care_self_paid',
  'insurance.refunded',
  'insurance.other',
  'prepayment.income_tax',
  'prepayment.solidarity',
  'prepayment.church_tax',
] as const;

export type ReturnItemKey = (typeof RETURN_ITEM_KEYS)[number];

export function isReturnItemKey(value: unknown): value is ReturnItemKey {
  return typeof value === 'string' && (RETURN_ITEM_KEYS as readonly string[]).includes(value);
}

export const RETURN_ITEM_KINDS: Record<ReturnItemKey, ReturnItemKind> = {
  'employment.home_office_days': {
    key: 'employment.home_office_days',
    label: 'Tage im Homeoffice (Tagespauschale)',
    group: 'employment',
    measure: 'days',
    hint: 'Arbeitstage, an denen überwiegend zu Hause gearbeitet wurde.',
  },
  'employment.commute': {
    key: 'employment.commute',
    label: 'Wege zur ersten Tätigkeitsstätte oder Hochschule',
    group: 'employment',
    measure: 'commute',
    hint: 'Tage und einfache Entfernung in vollen Kilometern, je Ort und Verkehrsmittel ein Eintrag. Ohne eigenen oder überlassenen Wagen (auch Firmenwagen) gilt ein Höchstbetrag von 4.500 Euro.',
  },
  'employment.union_dues': {
    key: 'employment.union_dues',
    label: 'Gewerkschafts- und Berufsverbandsbeiträge',
    group: 'employment',
    measure: 'amount',
    hint: 'Im Jahr gezahlt. Ab 2026 zählen sie zusätzlich zum Arbeitnehmer-Pauschbetrag.',
  },
  'employment.other': {
    key: 'employment.other',
    label: 'Weitere Werbungskosten ohne Beleg in der App',
    group: 'employment',
    measure: 'amount',
    hint: 'Kosten ohne Beleg in der App. Was als Beleg auf einer Zeile der Anlage N steht (auch „Sonstiges“), zählt schon und gehört nicht hierher.',
  },
  'special.vocational_training': {
    key: 'special.vocational_training',
    label: 'Eigene Berufsausbildung (Sonderausgaben)',
    group: 'special',
    measure: 'amount',
    hint: 'Zum Beispiel die Zinsen eines Studienkredits laut Jahresbescheinigung; höchstens 6.000 Euro.',
  },
  'special.donations': {
    key: 'special.donations',
    label: 'Spenden und Mitgliedsbeiträge',
    group: 'special',
    measure: 'amount',
    hint: 'An steuerbegünstigte Empfänger, mit Zuwendungsbestätigung.',
  },
  'special.church_tax_paid': {
    key: 'special.church_tax_paid',
    label: 'Kirchensteuer gezahlt, nicht über den Lohn',
    group: 'special',
    measure: 'amount',
    hint: 'Zum Beispiel eine Nachzahlung aus dem Bescheid eines Vorjahres. Die Kirchensteuer vom Lohn kommt aus den Lohndaten.',
  },
  'special.church_tax_refunded': {
    key: 'special.church_tax_refunded',
    label: 'Kirchensteuer erstattet',
    group: 'special',
    measure: 'amount',
    hint: 'In diesem Jahr erstattete Kirchensteuer, etwa aus dem Bescheid des Vorjahres. Ein Überhang wird den Einkünften hinzugerechnet.',
  },
  'insurance.pension_self_paid': {
    key: 'insurance.pension_self_paid',
    label: 'Rentenbeiträge selbst gezahlt',
    group: 'insurance',
    measure: 'amount',
    hint: 'Gesetzliche Rente oder Basisrente, nicht über den Lohn.',
  },
  'insurance.health_self_paid_sick_pay': {
    key: 'insurance.health_self_paid_sick_pay',
    label: 'Krankenversicherung selbst gezahlt, mit Krankengeld',
    group: 'insurance',
    measure: 'amount',
    hint: 'Basisbeiträge mit Anspruch auf Krankengeld; sie zählen 4 Prozent weniger.',
  },
  'insurance.health_self_paid': {
    key: 'insurance.health_self_paid',
    label: 'Krankenversicherung selbst gezahlt, ohne Krankengeld',
    group: 'insurance',
    measure: 'amount',
    hint: 'Basisbeiträge laut Bescheinigung der Kasse, zum Beispiel aus der Zeit vor der Anstellung.',
  },
  'insurance.care_self_paid': {
    key: 'insurance.care_self_paid',
    label: 'Pflegeversicherung selbst gezahlt',
    group: 'insurance',
    measure: 'amount',
    hint: 'Nicht über den Lohn.',
  },
  'insurance.refunded': {
    key: 'insurance.refunded',
    label: 'Erstattete Kranken- und Pflegebeiträge',
    group: 'insurance',
    measure: 'amount',
    hint: 'Beitragsrückerstattung laut Bescheinigung der Kasse; mindert die Beiträge.',
  },
  'insurance.other': {
    key: 'insurance.other',
    label: 'Weitere Versicherungen',
    group: 'insurance',
    measure: 'amount',
    hint: 'Haftpflicht, Unfall, Berufsunfähigkeit; zählen nur bis zum Höchstbetrag zusammen mit Kranken- und Pflegebeiträgen.',
  },
  'prepayment.income_tax': {
    key: 'prepayment.income_tax',
    label: 'Vorauszahlungen Einkommensteuer',
    group: 'prepayment',
    measure: 'amount',
    hint: 'Für dieses Jahr an das Finanzamt gezahlt.',
  },
  'prepayment.solidarity': {
    key: 'prepayment.solidarity',
    label: 'Vorauszahlungen Solidaritätszuschlag',
    group: 'prepayment',
    measure: 'amount',
    hint: 'Für dieses Jahr an das Finanzamt gezahlt.',
  },
  'prepayment.church_tax': {
    key: 'prepayment.church_tax',
    label: 'Vorauszahlungen Kirchensteuer',
    group: 'prepayment',
    measure: 'amount',
    hint: 'Für dieses Jahr an das Finanzamt gezahlt.',
  },
};

/** One stored item as the estimate sees it. */
export interface ReturnItemFact {
  id: string;
  key: ReturnItemKey;
  /** For `amount` items. */
  amountCents: number | null;
  /** For `days` and `commute` items. */
  days: number | null;
  /** For `commute` items: the one-way distance in full kilometres. */
  distanceKm: number | null;
  /** For `commute` items: travelled by one's own car or a car provided for use, such as a company car (no 4,500 euro cap). */
  ownCar: boolean;
  note: string | null;
}

export function sumAmount(items: readonly ReturnItemFact[], key: ReturnItemKey): number {
  return items.filter((i) => i.key === key).reduce((s, i) => s + (i.amountCents ?? 0), 0);
}

export function sumDays(items: readonly ReturnItemFact[], key: ReturnItemKey): number {
  return items.filter((i) => i.key === key).reduce((s, i) => s + (i.days ?? 0), 0);
}

export function itemsOf(items: readonly ReturnItemFact[], key: ReturnItemKey): ReturnItemFact[] {
  return items.filter((i) => i.key === key);
}
