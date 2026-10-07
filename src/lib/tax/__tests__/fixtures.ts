import type { Allocation, LedgerItem } from '../types';

/** A fully decided euro expense under section 19; tests override what they are about. */
export function item(overrides: Partial<LedgerItem> & { id: string }): LedgerItem {
  return {
    label: overrides.id,
    vendor: null,
    date: '2025-06-15',
    dateBasis: 'document',
    amountCents: 10000,
    amountBasis: 'document',
    formLineKey: 'euer.work_equipment',
    employmentLineKey: null,
    allocations: business(10000),
    smallBusiness: true,
    meal: null,
    ...overrides,
  };
}

export function business(shareBp: number): Allocation[] {
  return [{ purpose: 'business', shareBp }];
}

/**
 * A made-up year with the mix of cases a real return has. Every vendor, amount
 * and date in here is invented: this repository is public, and
 * the real worked year is only ever read from the owner's machine
 * (`private-golden.test.ts`).
 */
export const SYNTHETIC_YEAR: LedgerItem[] = [
  // Home internet: half business, three tenths study, the rest private.
  item({
    id: 'internet',
    vendor: 'Netzwerk Nord',
    amountCents: 41988,
    formLineKey: 'euer.telecom',
    employmentLineKey: 'employment.study_costs',
    allocations: [
      { purpose: 'business', shareBp: 5000 },
      { purpose: 'study', shareBp: 3000 },
    ],
  }),
  // Note-taking software billed in dollars, booked at the bank amount: a half cent to round.
  item({
    id: 'notes-software',
    amountCents: 12345,
    amountBasis: 'payment',
    dateBasis: 'payment',
    employmentLineKey: 'employment.study_costs',
    allocations: [
      { purpose: 'business', shareBp: 5000 },
      { purpose: 'study', shareBp: 3000 },
    ],
  }),
  // A dollar invoice with no payment linked yet: counted, flagged as estimated.
  item({ id: 'hosting-usd', amountCents: 8437, amountBasis: 'reference_rate' }),
  // Small hardware, expensed at once.
  item({ id: 'drive', amountCents: 28950, formLineKey: 'euer.low_value_assets' }),
  item({ id: 'dock', amountCents: 31299, formLineKey: 'euer.low_value_assets' }),
  // A laptop on the depreciation line (the schedule itself is the asset slice).
  item({ id: 'laptop', amountCents: 239900, formLineKey: 'euer.depreciation_movable' }),
  // A complete business meal: the register's 70 and 30 percent.
  item({
    id: 'meal-complete',
    amountCents: 5800,
    formLineKey: 'euer.meals',
    meal: { status: 'complete', deductibleCents: 4060, nonDeductibleCents: 1740 },
  }),
  // A meal without guests: not in any total.
  item({ id: 'meal-open', amountCents: 3550, formLineKey: 'euer.meals', meal: { status: 'incomplete' } }),
  // Study only: a semester fee.
  item({
    id: 'semester-fee',
    amountCents: 31200,
    formLineKey: null,
    employmentLineKey: 'employment.study_costs',
    allocations: [{ purpose: 'study', shareBp: 10000 }],
  }),
  // Fully private: counted nowhere, and needs no form line.
  item({ id: 'private-music', amountCents: 999, formLineKey: null, allocations: [{ purpose: 'private', shareBp: 10000 }] }),
  // Nobody has decided yet.
  item({ id: 'undecided', amountCents: 4480, allocations: null }),
  // A contractor.
  item({ id: 'contractor', amountCents: 21420, formLineKey: 'euer.external_services' }),
  // Last year's and next year's items stay out.
  item({ id: 'previous-year', date: '2024-12-30' }),
  item({ id: 'next-year', date: '2026-01-02' }),
];
