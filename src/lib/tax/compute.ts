import { assetChecks, assetSchedule, assetYearParts } from './assets';
import { WHOLE_BP, shareOf } from './money';
import { formLine, rulesForYear, type ResolvedRules } from './rules';
import type { AssetRules } from './rules/types';
import type { FormLineKey } from './rules/types';
import type {
  AssetYearResult,
  InvoiceResult,
  ItemPart,
  ItemResult,
  LedgerItem,
  LineResult,
  OpenCheck,
  OpenCheckKind,
  RevenueResult,
  VatEvent,
  YearFacts,
  YearResult,
} from './types';

/**
 * The one place a year is computed. Pure: facts and rules in, figures out.
 * The dashboard, a scenario and a hint all call this, so they cannot disagree.
 *
 * An item that lacks a decision is never guessed at and never counted as
 * zero: it is left out of the totals and reported as an open check with its
 * reason. Open checks that do not change the figure (an estimated exchange
 * rate) leave the item in and are reported beside it.
 */

const MEAL_LINE: FormLineKey = 'euer.meals';
const INPUT_VAT_LINE: FormLineKey = 'euer.input_vat';

function yearOf(isoDay: string): number {
  return Number(isoDay.slice(0, 4));
}

function computeItem(item: LedgerItem, assetRules: AssetRules): ItemResult {
  // Part of an asset's cost: not an expense of its own. Whatever is missing on
  // the receipt is reported on the asset, where it matters.
  if (item.assetId) return { itemId: item.id, counted: true, parts: [], privateCents: 0, checks: [] };

  const checks: OpenCheck[] = [];
  const block = (kind: OpenCheckKind) => checks.push({ itemId: item.id, kind, blocking: true });
  const note = (kind: OpenCheckKind) => checks.push({ itemId: item.id, kind, blocking: false });

  if (item.amountCents === null) block(item.missingAmount === 'no_exchange_rate' ? 'no_exchange_rate' : 'no_amount');
  if (item.smallBusiness === null) block('small_business_unanswered');
  // Under regular taxation the cost is the net amount and the tax in the
  // receipt is input tax. A private-only item needs neither.
  const regular = item.smallBusiness === false;

  const allocations = item.allocations;
  let allocated = 0;
  if (allocations === null) {
    block('no_allocation');
  } else {
    allocated = allocations.reduce((sum, a) => sum + a.shareBp, 0);
    if (allocated > WHOLE_BP || allocations.some((a) => a.shareBp < 0 || !Number.isInteger(a.shareBp))) {
      block('allocation_exceeds_whole');
    }
  }

  const shareFor = (purposes: readonly string[]) =>
    (allocations ?? []).filter((a) => purposes.includes(a.purpose)).reduce((sum, a) => sum + a.shareBp, 0);
  const businessBp = shareFor(['business']);
  const employmentBp = shareFor(['study', 'employment']);

  if (businessBp > 0 && item.formLineKey === null) block('no_form_line');
  const net = item.netCents ?? null;
  if (regular && businessBp > 0 && item.amountCents !== null && net === null && item.formLineKey !== MEAL_LINE) {
    block('net_amount_missing');
  }
  if (employmentBp > 0 && item.employmentLineKey === null) block('no_employment_line');

  // A receipt on the low-value asset line must be allowed to be one: the limit
  // is a net amount, decided from the gross amount only where that is conclusive.
  if (item.formLineKey === 'euer.low_value_assets' && businessBp > 0 && item.amountCents !== null && !item.severalLowValueItems) {
    const limit = assetRules.lowValueNetLimitCents.value;
    if (item.netCents !== null && item.netCents !== undefined) {
      if (item.netCents > limit) block('needs_asset');
    } else if (item.amountCents > limit + shareOf(limit, assetRules.highestVatRateBp.value)) {
      block('needs_asset');
    } else if (item.amountCents > limit) {
      block('net_amount_needed');
    }
  }

  const isMeal = item.formLineKey === MEAL_LINE && businessBp > 0;
  if (isMeal) {
    if (item.meal === null) block('meal_without_register_facts');
    else if (item.meal.status === 'incomplete') block('meal_incomplete');
    else if (item.meal.status === 'no_amount') block('no_amount');
    // 'setting_missing' needs no check of its own: the unanswered section 19
    // question already blocks the item above.
  }

  if (checks.some((c) => c.blocking)) {
    return { itemId: item.id, counted: false, parts: [], privateCents: 0, checks };
  }
  if (item.amountBasis === 'reference_rate') note('amount_estimated');

  const amount = item.amountCents as number;
  const parts: ItemPart[] = [];
  let deducted = 0;

  for (const allocation of allocations ?? []) {
    if (allocation.shareBp === 0 || allocation.purpose === 'private') continue;
    if (allocation.purpose === 'business') {
      if (isMeal) {
        // The register decides what a meal is worth; a share is deliberately
        // not applied on top (see the meal register's rules). A meal the
        // register excludes (private, staff, travel) contributes nothing here.
        if (item.meal?.status === 'complete') {
          parts.push({
            lineKey: MEAL_LINE,
            purpose: 'business',
            cents: item.meal.deductibleCents,
            nonDeductibleCents: item.meal.nonDeductibleCents,
          });
          deducted += item.meal.deductibleCents;
          if (regular && (item.meal.inputVatCents ?? 0) > 0) {
            parts.push({ lineKey: INPUT_VAT_LINE, purpose: 'business', cents: item.meal.inputVatCents as number, nonDeductibleCents: 0 });
            deducted += item.meal.inputVatCents as number;
          }
        }
        continue;
      }
      if (regular) {
        // The business share of the net amount is the expense; the same share
        // of the tax is input tax, deductible on its own line. The tax on the
        // private and study shares is not deductible and stays in their cost.
        const netPart = shareOf(net as number, allocation.shareBp);
        const vatPart = shareOf(amount - (net as number), allocation.shareBp);
        parts.push({ lineKey: item.formLineKey as FormLineKey, purpose: 'business', cents: netPart, nonDeductibleCents: 0 });
        if (vatPart !== 0) parts.push({ lineKey: INPUT_VAT_LINE, purpose: 'business', cents: vatPart, nonDeductibleCents: 0 });
        deducted += netPart + vatPart;
        continue;
      }
      const cents = shareOf(amount, allocation.shareBp);
      parts.push({ lineKey: item.formLineKey as FormLineKey, purpose: 'business', cents, nonDeductibleCents: 0 });
      deducted += cents;
    } else {
      const cents = shareOf(amount, allocation.shareBp);
      parts.push({
        lineKey: item.employmentLineKey as FormLineKey,
        purpose: allocation.purpose,
        cents,
        nonDeductibleCents: 0,
      });
      deducted += cents;
    }
  }

  return { itemId: item.id, counted: true, parts, privateCents: Math.max(0, amount - deducted), checks };
}

export function computeYear(facts: YearFacts, resolved: ResolvedRules): YearResult {
  const { rules, exact } = resolved;
  const items: ItemResult[] = [];
  const checks: OpenCheck[] = [];
  const byLine = new Map<FormLineKey, LineResult>();
  const inputVatEvents: VatEvent[] = [];

  const lineFor = (key: FormLineKey): LineResult => {
    let line = byLine.get(key);
    if (!line) {
      const def = formLine(rules, key);
      line = {
        key: def.key,
        form: def.form,
        line: def.numbering === 'verified' ? def.line : null,
        numbering: def.numbering,
        label: def.label,
        kind: def.kind,
        cents: 0,
        nonDeductibleCents: 0,
        itemIds: [],
        assetIds: [],
      };
      byLine.set(key, line);
    }
    return line;
  };

  for (const item of facts.items) {
    // An item without a date cannot be placed in any year, so it shows up in
    // every year's queue until it has one.
    if (item.date === null) {
      if (item.assetId) continue;
      const check: OpenCheck = { itemId: item.id, kind: 'no_date', blocking: true };
      items.push({ itemId: item.id, counted: false, parts: [], privateCents: 0, checks: [check] });
      checks.push(check);
      continue;
    }
    if (yearOf(item.date) !== facts.year) continue;

    const result = computeItem(item, rules.assets);
    items.push(result);
    checks.push(...result.checks);

    for (const part of result.parts) {
      const line = lineFor(part.lineKey);
      line.cents += part.cents;
      line.nonDeductibleCents += part.nonDeductibleCents;
      if (!line.itemIds.includes(item.id)) line.itemIds.push(item.id);
      if (part.lineKey === INPUT_VAT_LINE) inputVatEvents.push({ date: item.date, cents: part.cents, source: 'item', id: item.id });
    }
  }

  const assets: AssetYearResult[] = [];
  for (const stated of facts.assets ?? []) {
    const firstYear = stated.opening ? stated.opening.year : stated.acquisitionDate ? Number(stated.acquisitionDate.slice(0, 4)) : null;
    // The limits and methods that apply are those of the year the asset was bought.
    const assetRules = rulesForYear(firstYear ?? facts.year).rules.assets;
    const found = assetChecks(stated, assetRules);
    if (found.some((c) => c.blocking)) {
      // An asset without a date belongs to every year's queue, like a receipt
      // without one; a dated asset only to its own year and the years after.
      if (firstYear === null || firstYear <= facts.year) assets.push({ assetId: stated.id, counted: false, row: null, parts: [], checks: found });
      continue;
    }
    if ((firstYear as number) > facts.year) continue;

    // Under regular taxation the asset costs its net amount; the tax in the
    // purchase is input tax of the year it was bought.
    const regular = stated.smallBusiness === false && stated.opening === null;
    const asset = regular ? { ...stated, costCents: stated.netCostCents } : stated;
    const row = assetSchedule(asset, assetRules, facts.year).find((r) => r.year === facts.year) ?? null;
    const parts = row ? assetYearParts(asset, row) : [];
    if (regular && firstYear === facts.year) {
      const vat = shareOf((stated.costCents as number) - (stated.netCostCents as number), stated.businessShareBp);
      if (vat !== 0) {
        parts.push({ lineKey: INPUT_VAT_LINE, cents: vat });
        inputVatEvents.push({ date: stated.acquisitionDate as string, cents: vat, source: 'asset', id: stated.id });
      }
    }
    // Bought under one status and still in the register under the other: the
    // input tax taken (or not taken) at purchase may have to be corrected.
    // That is a judgment for a tax advisor, so it is reported, never computed.
    const notes = [...found];
    if (
      row !== null &&
      row.bookValueEndCents > 0 &&
      stated.opening === null &&
      facts.smallBusinessAtYearEnd !== undefined &&
      facts.smallBusinessAtYearEnd !== null &&
      stated.smallBusiness !== null &&
      facts.smallBusinessAtYearEnd !== stated.smallBusiness
    ) {
      notes.push({ assetId: stated.id, kind: 'asset_input_tax_correction_review', blocking: false });
    }
    assets.push({ assetId: stated.id, counted: true, row, parts, checks: notes });
    for (const part of parts) {
      const line = lineFor(part.lineKey);
      line.cents += part.cents;
      if (!line.assetIds.includes(stated.id)) line.assetIds.push(stated.id);
    }
  }

  const revenue = computeRevenue(facts, (key, cents) => {
    lineFor(key).cents += cents;
  });

  for (const settlement of facts.vatSettlements ?? []) {
    if (yearOf(settlement.date) !== facts.year || settlement.cents === 0) continue;
    lineFor(settlement.direction === 'paid' ? 'euer.vat_paid' : 'euer.vat_refunded').cents += settlement.cents;
  }

  const order = new Map(rules.formLines.map((l, index) => [l.key, index]));
  const lines = [...byLine.values()].sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  const sum = (form: LineResult['form'], kind: LineResult['kind']) =>
    lines.filter((l) => l.form === form && l.kind === kind).reduce((total, l) => total + l.cents, 0);
  const businessExpenseCents = sum('euer', 'expense');
  const businessRevenueCents = sum('euer', 'revenue');

  return {
    year: facts.year,
    rulesYear: rules.year,
    rulesExact: exact,
    lines,
    businessExpenseCents,
    businessRevenueCents,
    revenue: revenue.result,
    profitCents: revenue.result.recorded ? businessRevenueCents - businessExpenseCents : null,
    inputVatEvents,
    outputVatByIssue: revenue.outputVatByIssue,
    outputVatByPayment: revenue.outputVatByPayment,
    employmentCostCents: sum('employment', 'expense'),
    privateCents: items.reduce((total, i) => total + i.privateCents, 0),
    items,
    checks,
    assets,
    assetChecks: assets.flatMap((a) => a.checks),
    countedItems: items.filter((i) => i.counted).length,
    blockedItems: items.filter((i) => !i.counted).length,
  };
}

/**
 * Revenue from issued invoices, by the day the money arrived.
 *
 * An invoice with tax splits every payment into its net and its tax part in
 * the proportion of the invoice. The split is taken as the difference of two
 * cumulative figures, so partial payments add up to exactly the tax on the
 * invoice. The turnover the small-business limits measure is money received
 * without the tax in it, whatever year's return declared the invoice.
 */
function computeRevenue(
  facts: YearFacts,
  addToLine: (key: FormLineKey, cents: number) => void,
): { result: RevenueResult; outputVatByIssue: VatEvent[]; outputVatByPayment: VatEvent[] } {
  const byMonth = Array.from({ length: 12 }, () => 0);
  const invoices: InvoiceResult[] = [];
  const outputVatByIssue: VatEvent[] = [];
  const outputVatByPayment: VatEvent[] = [];
  let receivedCents = 0;
  let outstandingCents = 0;
  const yearEnd = `${facts.year}-12-31`;

  for (const invoice of facts.invoices ?? []) {
    const result: InvoiceResult = { invoiceId: invoice.id, receivedCents: 0, excludedCents: 0, outstandingCents: 0, parts: [], checks: [] };
    const taxed = invoice.treatment === 'standard' || invoice.treatment === 'reduced';
    const vat = taxed ? Math.max(0, Math.min(invoice.vatCents, invoice.grossCents)) : 0;

    if (invoice.issueDate === null) result.checks.push('invoice_no_date');
    else {
      if (invoice.smallBusinessOnIssue === false && invoice.treatment === 'small_business') result.checks.push('invoice_treatment_mismatch');
      if (invoice.smallBusinessOnIssue === true && taxed) result.checks.push('invoice_treatment_mismatch');
      if (vat > 0 && yearOf(invoice.issueDate) === facts.year) {
        outputVatByIssue.push({ date: invoice.issueDate, cents: vat, source: 'invoice', id: invoice.id });
      }
    }

    const netLine: FormLineKey =
      invoice.treatment === 'small_business' ? 'euer.revenue_small_business' : taxed ? 'euer.revenue_taxable' : 'euer.revenue_not_taxable';
    const partsByLine = new Map<FormLineKey, number>();
    const payments = [...invoice.payments].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let paidBefore = 0;
    let paidUntilYearEnd = 0;
    for (const payment of payments) {
      const paidAfter = paidBefore + payment.cents;
      // The tax share of what was paid so far, capped at the tax on the invoice.
      const vatShare = (paid: number) => (invoice.grossCents > 0 ? Math.min(vat, Math.round((vat * Math.min(paid, invoice.grossCents)) / invoice.grossCents)) : 0);
      const vatPart = vatShare(paidAfter) - vatShare(paidBefore);
      const netPart = payment.cents - vatPart;
      paidBefore = paidAfter;
      if (payment.date <= yearEnd) paidUntilYearEnd += payment.cents;
      if (yearOf(payment.date) !== facts.year) continue;

      result.receivedCents += payment.cents;
      byMonth[Number(payment.date.slice(5, 7)) - 1] += netPart;
      if (vatPart !== 0) outputVatByPayment.push({ date: payment.date, cents: vatPart, source: 'invoice', id: invoice.id });
      if (invoice.declaredInYear !== null && invoice.declaredInYear !== facts.year) {
        result.excludedCents += payment.cents;
        continue;
      }
      partsByLine.set(netLine, (partsByLine.get(netLine) ?? 0) + netPart);
      if (vatPart !== 0) partsByLine.set('euer.vat_received', (partsByLine.get('euer.vat_received') ?? 0) + vatPart);
    }
    if (paidBefore > invoice.grossCents) result.checks.push('invoice_overpaid');
    // Outstanding at the end of this year; an invoice issued later is not this year's business.
    if (invoice.issueDate === null || invoice.issueDate <= yearEnd) {
      result.outstandingCents = Math.max(0, invoice.grossCents - paidUntilYearEnd);
    }
    for (const [lineKey, cents] of partsByLine) {
      if (cents === 0) continue;
      result.parts.push({ lineKey, cents });
      addToLine(lineKey, cents);
    }
    receivedCents += result.receivedCents;
    outstandingCents += result.outstandingCents;
    // Only invoices that touch the year are listed.
    if (result.receivedCents !== 0 || result.outstandingCents !== 0 || result.checks.length > 0 || (invoice.issueDate !== null && yearOf(invoice.issueDate) === facts.year)) {
      invoices.push(result);
    }
  }

  return {
    result: {
      recorded: facts.invoices !== undefined,
      receivedCents,
      turnoverByMonthCents: byMonth,
      turnoverCents: byMonth.reduce((s, c) => s + c, 0),
      outstandingCents,
      invoices,
    },
    outputVatByIssue,
    outputVatByPayment,
  };
}
