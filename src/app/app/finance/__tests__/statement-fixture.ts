import { rulesForYear } from '@/lib/tax/rules';
import { incomeTaxView } from '@/lib/tax/income-tax/__tests__/fixtures';
import type { WageEntry } from '@/lib/tax/income-tax/wages';
import type { AssetView, InvoiceView, OpenPayment, StatementItem, StatementView } from '@/lib/tax/service';
import { vatYear } from '@/lib/tax/vat';
import type { BankView } from '../bank-actions';
import type { OwnNamesView } from '../own-names-actions';
import type { SharingView } from '../sharing-actions';

/**
 * A year of a small company as the server would send it, with something in
 * every corner of the page: decided and open receipts, a foreign currency, a
 * split, an asset, invoices paid and overdue, advance returns, wages, three
 * accounts and every kind of payment question. The figures tests render it,
 * tab by tab.
 */

const item = (rowId: string, o: Partial<StatementItem> = {}): StatementItem => ({
  itemId: rowId,
  rowId,
  lineId: null,
  lineDescription: null,
  lineGrossCents: null,
  lineNetCents: null,
  receiptGrossCents: 11_900,
  receiptLines: [],
  paidOn: null,
  label: `Rechnung ${rowId}`,
  vendor: 'Netzwerk Nord GmbH',
  vendorKey: 'netzwerk nord',
  date: '2025-03-14',
  category: 'Telefon & Internet',
  gross: 119,
  currency: 'EUR',
  amountCents: 11_900,
  amountBasis: 'document',
  allocations: [{ purpose: 'business', shareBp: 10_000 }],
  allocationOrigin: 'item',
  formLineKey: 'euer.telecom',
  formLineOrigin: 'category_default',
  employmentLineKey: null,
  severalLowValueItems: false,
  hasDecision: true,
  decisionNote: null,
  vendorRuleId: null,
  isMeal: false,
  assetId: null,
  counted: true,
  parts: [{ lineKey: 'euer.telecom', purpose: 'business', cents: 11_900, nonDeductibleCents: 0 }],
  privateCents: 0,
  reverseCharge: null,
  reverseChargeOwn: null,
  checks: [],
  ...o,
});

const asOpen = (rowId: string, kind: StatementItem['checks'][number]['kind'], o: Partial<StatementItem> = {}) =>
  item(rowId, { counted: false, parts: [], allocations: null, allocationOrigin: null, hasDecision: false, checks: [{ itemId: rowId, kind, blocking: true }], ...o });

const items: StatementItem[] = [
  item('tel-1'),
  item('tel-2', { date: '2025-06-02', amountCents: 5_950, gross: 59.5, receiptGrossCents: 5_950, allocations: [{ purpose: 'business', shareBp: 5_000 }, { purpose: 'private', shareBp: 5_000 }], parts: [{ lineKey: 'euer.telecom', purpose: 'business', cents: 2_975, nonDeductibleCents: 0 }], privateCents: 2_975 }),
  item('usd-1', { vendor: 'Cloud Example Inc.', vendorKey: 'cloud example', currency: 'USD', gross: 80, receiptGrossCents: 7_350, amountCents: 7_350, amountBasis: 'reference_rate', date: '2025-09-30', checks: [{ itemId: 'usd-1', kind: 'amount_estimated', blocking: false }], parts: [{ lineKey: 'euer.telecom', purpose: 'business', cents: 7_350, nonDeductibleCents: 0 }] }),
  item('line-1', { itemId: 'line-1:a', lineId: 'a', lineDescription: 'Router', vendor: 'Technik Beispiel', vendorKey: 'technik beispiel', receiptLines: [{ id: 'a', description: 'Router', grossCents: 8_000, netCents: null }, { id: 'b', description: 'Kabel', grossCents: 3_900, netCents: null }], amountCents: 8_000, parts: [{ lineKey: 'euer.telecom', purpose: 'business', cents: 8_000, nonDeductibleCents: 0 }], allocationOrigin: 'line' }),
  asOpen('open-1', 'no_allocation', { vendor: 'Kanzlei Beispiel', vendorKey: 'kanzlei beispiel', date: '2025-02-11' }),
  asOpen('open-2', 'needs_asset', { vendor: 'Kamera Beispiel', vendorKey: 'kamera beispiel', amountCents: 95_200, gross: 952, receiptGrossCents: 95_200, formLineKey: 'euer.low_value_assets' }),
  asOpen('open-3', 'meal_incomplete', { vendor: 'Lokal Beispiel', vendorKey: 'lokal beispiel', isMeal: true, category: 'Bewirtung' }),
  asOpen('open-4', 'no_date', { date: null, vendor: 'Ohne Datum GmbH', vendorKey: 'ohne datum' }),
  asOpen('year-1', 'no_allocation', { date: '2025-12-30', paidOn: '2026-01-04', vendor: 'Vermieter Beispiel', vendorKey: 'vermieter beispiel' }),
];

const invoice = (id: string, o: Partial<InvoiceView> = {}): InvoiceView => ({
  id,
  number: `R-2025-${id}`,
  issueDate: '2025-03-01',
  grossCents: 150_000,
  vatCents: 0,
  treatment: 'small_business',
  taxGroups: null,
  declaredInYear: null,
  source: 'register',
  dueDate: null,
  cancelledOn: null,
  replacesNumber: null,
  payments: [{ date: '2025-03-20', cents: 150_000 }],
  enteredPayments: [{ date: '2025-03-20', cents: 150_000 }],
  writtenOffCents: 0,
  writtenOffOn: null,
  receivedCents: 150_000,
  excludedCents: 0,
  declaredCents: 0,
  outstandingCents: 0,
  checks: [],
  ...o,
});

const asset: AssetView = {
  id: 'asset-1',
  label: 'Kamera',
  kind: 'movable',
  acquisitionDate: '2025-04-01',
  method: 'linear',
  usefulLifeMonths: 84,
  decliningRateBp: null,
  businessShareBp: 8_000,
  annexShareBp: 0,
  annexLineKey: null,
  reminderCents: 0,
  opening: null,
  disposal: null,
  costCents: 168_000,
  netCostCents: 168_000,
  itemIds: [],
  counted: true,
  checks: [],
  row: { year: 2025, bookValueStartCents: 0, additionCents: 168_000, depreciationCents: 18_000, disposalBookValueCents: 0, bookValueEndCents: 150_000 },
  parts: [{ lineKey: 'euer.depreciation_movable', cents: 14_400 }],
  schedule: [
    { year: 2025, bookValueStartCents: 0, additionCents: 168_000, depreciationCents: 18_000, disposalBookValueCents: 0, bookValueEndCents: 150_000 },
    { year: 2026, bookValueStartCents: 150_000, additionCents: 0, depreciationCents: 24_000, disposalBookValueCents: 0, bookValueEndCents: 126_000 },
  ],
};

const assetWithCheck: AssetView = { ...asset, id: 'asset-2', label: 'Drucker', counted: false, parts: [], row: null, schedule: [], checks: [{ assetId: 'asset-2', kind: 'asset_no_date', blocking: true }] as AssetView['checks'] };

const openPayment: OpenPayment = {
  id: 'p-1',
  bookingDay: '2025-03-15',
  amountCents: -11_900,
  freeCents: 11_900,
  counterparty: 'Netzwerk Nord GmbH',
  reference: 'Kundennummer 4711',
  kind: 'spend',
  accountLabel: 'Geschäftskonto',
  check: 'payment_without_document',
  proposals: [{ rowId: 'tel-1', label: 'Rechnung tel-1', strength: 'exact', cents: 11_900 }] as unknown as OpenPayment['proposals'],
  namesService: false,
};

const wage: WageEntry = {
  id: 'w-1',
  employer: 'Arbeitgeber Beispiel GmbH',
  month: 0,
  healthWithSickPay: true,
  churchLiable: null,
  grossCents: 4_800_000,
  wageTaxCents: 720_000,
  solidarityCents: 0,
  churchTaxCents: 0,
  pensionEmployeeCents: 446_400,
  pensionEmployerCents: 446_400,
  healthEmployeeCents: 389_000,
  careEmployeeCents: 89_000,
  unemploymentEmployeeCents: 62_400,
};

export function fullStatement(): StatementView {
  const { rules } = rulesForYear(2025);
  const inputVat = [{ date: '2025-03-14', cents: 1_900, label: 'Rechnung tel-1' }] as unknown as Parameters<typeof vatYear>[3]['inputVat'];
  const output = [{ date: '2025-03-01', cents: 28_500, label: 'R-2025-1', rateBp: 1900, baseCents: 150_000 }] as unknown as Parameters<typeof vatYear>[3]['outputVatByIssue'];
  return {
    readAt: 1,
    year: 2025,
    years: [2026, 2025, 2024],
    smallBusiness: false,
    rulesYear: 2025,
    rulesExact: true,
    rulesReviewedOn: rules.reviewedOn,
    rulesProvisional: rules.provisional ?? null,
    formSources: rules.formSources,
    formLines: [...rules.formLines],
    lines: [
      { key: 'euer.revenue_taxable', form: 'euer', line: 15, numbering: 'verified', label: 'Umsatzsteuerpflichtige Betriebseinnahmen', kind: 'revenue', cents: 350_000, nonDeductibleCents: 0, itemIds: [], assetIds: [] },
      { key: 'euer.telecom', form: 'euer', line: 43, numbering: 'verified', label: 'Aufwendungen für Telekommunikation (z. B. Telefon, Internet)', kind: 'expense', cents: 30_225, nonDeductibleCents: 0, itemIds: ['tel-1', 'tel-2', 'usd-1', 'line-1:a'], assetIds: [] },
      { key: 'euer.depreciation_movable', form: 'euer', line: 30, numbering: 'verified', label: 'AfA auf bewegliche Wirtschaftsgüter', kind: 'expense', cents: 14_400, nonDeductibleCents: 0, itemIds: [], assetIds: ['asset-1'] },
    ] as StatementView['lines'],
    businessExpenseCents: 44_625,
    employmentCostCents: 12_000,
    privateCents: 2_975,
    countedItems: 4,
    blockedItems: 5,
    items,
    assets: [asset, assetWithCheck],
    assetLimits: { lowValueNetLimitCents: 80_000, poolMinExclusiveNetCents: 25_000, poolMaxNetCents: 100_000, poolYears: 5, decliningFrom: '2025-07-01', decliningTo: '2027-12-31', decliningMaxRateBp: 3_000, decliningMaxMultiple: 3 },
    businessRevenueCents: 350_000,
    profitCents: 305_375,
    revenue: {
      recorded: true,
      receivedCents: 350_000,
      turnoverCents: 350_000,
      outstandingCents: 120_000,
      invoices: [
        invoice('1'),
        invoice('2', { issueDate: '2025-05-02', grossCents: 200_000, payments: [{ date: '2025-05-20', cents: 200_000 }], enteredPayments: [], receivedCents: 200_000 }),
        invoice('3', { issueDate: '2025-10-02', grossCents: 120_000, payments: [], enteredPayments: [], receivedCents: 0, outstandingCents: 120_000 }),
      ],
      overdue: [{ invoiceId: '3', number: 'R-2025-3', issueDate: '2025-10-02', dueDate: '2025-10-16', openCents: 120_000, daysPastDue: 76 }],
    },
    forecast: { year: 2025, monthsElapsed: 12, receivedCents: 350_000, outstandingCents: 120_000, lowCents: 470_000, highCents: 470_000, monthlyRateCents: 29_166, rateBasis: 'run_rate', basisMonths: 12, thinBasis: false, currentYear: { state: 'not_reached' }, nextYear: { state: 'not_reached' }, previousYearWithinLimit: true },
    limits: { previousYearLimitCents: 2_500_000, currentYearLimitCents: 10_000_000, currentYearLimit: 'at_once', nextYearLimitCents: 2_500_000, source: rules.smallBusinessLimits.source },
    expectedMonthlyRevenueCents: 30_000,
    smallBusinessAtYearEnd: false,
    statusChanges: [{ id: 'st-1', effectiveFrom: '2025-01-01', smallBusiness: false }],
    vat: {
      frequency: 'quarterly',
      method: 'issued',
      applies: true,
      year: vatYear(2025, 'quarterly', 'issued', { inputVat, outputVatByIssue: output, outputVatByPayment: output }),
      undeductedInputVatCents: 0,
      reverseChargeYear: null,
      reverseChargePendingItems: 1,
      reverseChargeNonBusinessCents: 0,
      reverseChargeForeignCurrencyItems: 1,
      settlements: [{ id: 'se-1', date: '2025-04-10', cents: 26_600, direction: 'paid' }],
    },
    payments: {
      accounts: [
        { id: 'acc-1', label: 'Geschäftskonto', kind: 'bank', isPrivate: false, paymentCount: 3, completeThrough: '2025-12-22', batches: [{ id: 'b-1', format: 'n26_csv', service: null, newCount: 3, paymentCount: 3, firstDay: '2025-01-05', lastDay: '2025-12-22', importedAt: '2026-01-02T08:00:00.000Z' }] },
        { id: 'acc-2', label: 'Privatkonto', kind: 'bank', isPrivate: true, paymentCount: 1, completeThrough: '2025-06-01', batches: [] },
        { id: 'acc-3', label: 'Kreditkarte', kind: 'card', isPrivate: false, paymentCount: 0, completeThrough: null, batches: [] },
      ],
      yearCount: 4,
      linkedCount: 1,
      transferCount: 1,
      unclassified: [{ key: 'vermieter beispiel', label: 'Vermieter Beispiel', count: 2, outCents: 130_000, inCents: 0, proposal: { treatment: 'business', confidence: 'likely', reason: 'Miete für das Büro' } }],
      treatments: [{ key: 'bäckerei beispiel', label: 'Bäckerei Beispiel', treatment: 'private' }],
      classifierAvailable: true,
      filedOn: null,
      appTreatments: [{ key: 'finanzamt', label: 'Finanzamt', treatment: 'business', source: 'app', reason: 'Steuerzahlung' }],
      open: [openPayment, { ...openPayment, id: 'p-2', amountCents: 150_000, freeCents: 150_000, counterparty: 'Kunde Beispiel AG', kind: 'income', check: 'income_without_invoice', proposals: [] }],
      estimateProposals: [{ paymentId: 'p-3', rowId: 'usd-1', receiptLabel: 'Cloud Example Inc.', receiptDay: '2025-09-30', estimateCents: 7_350, bookingDay: '2025-10-01', paidCents: 7_412, counterparty: 'Cloud Example', accountLabel: 'Kreditkarte', unambiguous: true, severalReceipts: false, originalAmount: false, foreign: null }],
      overridden: [{ id: 'p-4', bookingDay: '2025-05-05', amountCents: -2_000, counterparty: 'Versand Beispiel', kind: 'refund' }],
      ruleTransfers: [{ id: 'p-5', bookingDay: '2025-07-01', amountCents: -4_999, counterparty: 'PayPal', reference: 'Abbuchung', accountLabel: 'Geschäftskonto', hasTwin: true, awaitingList: false, linkedTo: [] }],
      ruleTransferCents: 4_999,
      reconciliations: [],
      cancelled: [{ id: 'p-6', bookingDay: '2025-08-08', amountCents: -1_500, counterparty: 'Shop Beispiel', accountLabel: 'Kreditkarte', releasedFrom: ['Rechnung x'] }],
      receiptTargets: [{ id: 'open-1', label: 'Kanzlei Beispiel', day: '2025-02-11', amountCents: 11_900, linkedCents: 0 }],
      invoiceTargets: [{ id: '3', label: 'R-2025-3', openCents: 120_000 }],
      links: [{ linkId: 'l-1', paymentId: 'p-7', bookingDay: '2025-03-20', cents: 150_000, counterparty: 'Kunde Beispiel AG', target: 'invoice', rowId: null, targetLabel: 'R-2025-1', method: 'reference', counts: true }],
    },
    vendorRules: [{ id: 'vr-1', vendorKey: 'netzwerk nord', vendorLabel: 'Netzwerk Nord GmbH', effectiveFrom: '', allocations: [{ purpose: 'business', shareBp: 10_000 }], formLineKey: 'euer.telecom', employmentLineKey: null, severalLowValueItems: false }] as StatementView['vendorRules'],
    reverseChargeVendors: [{ id: 'rc-1', label: 'Cloud Example Inc.', vendorKey: 'cloud example', effectiveFrom: '2025-01-01', rateBp: 1_900 }],
    initialized: true,
    incomeTax: incomeTaxView({ year: 2025, wageEntries: [wage], profitCents: 305_375, federalState: 'BE', churchMonths: null, filedOn: null }),
  };
}

/** The same year after the first open payment was linked to the receipt it proposed: a change that shows on several tabs at once. */
export function afterLink(): StatementView {
  const base = fullStatement();
  return {
    ...base,
    readAt: 2,
    items: base.items.filter((i) => i.rowId !== 'open-1'),
    blockedItems: base.blockedItems - 1,
    countedItems: base.countedItems + 1,
    businessExpenseCents: base.businessExpenseCents + 11_900,
    profitCents: (base.profitCents as number) - 11_900,
    payments: {
      ...base.payments,
      linkedCount: base.payments.linkedCount + 1,
      open: base.payments.open.filter((p) => p.id !== 'p-1'),
      links: [...base.payments.links, { linkId: 'l-2', paymentId: 'p-1', bookingDay: '2025-03-15', cents: 11_900, counterparty: 'Netzwerk Nord GmbH', target: 'receipt', rowId: 'tel-1', targetLabel: 'Rechnung tel-1', method: 'confirmed', counts: true }],
    },
    incomeTax: incomeTaxView({ year: 2025, wageEntries: [wage], profitCents: 293_475, federalState: 'BE', churchMonths: null, filedOn: null }),
  };
}

export const bankView: BankView = {
  readAt: 1,
  enabled: true,
  connections: [
    {
      id: 'conn-1',
      accountId: 'acc-1',
      status: 'active',
      aspspName: 'Beispielbank',
      pendingAspspName: null,
      validUntil: '2026-03-01T00:00:00.000Z',
      renewSoon: false,
      lastSyncedAt: '2025-12-23T06:00:00.000Z',
      lastBookedThrough: '2025-12-22',
      lastError: null,
      lastErrorAt: null,
      notices: { gaps: [], skipped: [], undated: [], unrated: [] },
      candidates: [],
      accountUid: 'uid-1',
      boundMask: null,
      boundName: null,
    },
  ],
};

export const sharingView: SharingView = {
  readAt: 1,
  outgoing: [],
  incoming: [],
  targets: [{ workspaceId: 'ws-2', label: 'Zweite Firma' }],
  canWrite: true,
};

export const ownNamesView: OwnNamesView = { readAt: 1, names: ['Inhaber Beispiel'], canWrite: true };
