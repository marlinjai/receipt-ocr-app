import { assetChecks, assetSchedule, assetYearParts } from './assets';
import { WHOLE_BP, shareOf } from './money';
import { formLine, rulesForYear, type ResolvedRules } from './rules';
import type { AssetRules } from './rules/types';
import type { FormLineKey } from './rules/types';
import type {
  AssetYearResult,
  ItemPart,
  ItemResult,
  LedgerItem,
  LineResult,
  OpenCheck,
  OpenCheckKind,
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
  // Net amounts and input tax are a separate build; until it exists an item
  // under regular taxation is reported, not computed on the wrong basis.
  if (item.smallBusiness === false) block('regular_taxation_not_computed');

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
        }
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

  for (const item of facts.items) {
    // An item without a date cannot be placed in any year, so it shows up in
    // every year's queue until it has one.
    if (item.date === null) {
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
      let line = byLine.get(part.lineKey);
      if (!line) {
        const def = formLine(rules, part.lineKey);
        line = {
          key: def.key,
          form: def.form,
          line: rules.formLinesVerified ? def.line : null,
          label: def.label,
          kind: def.kind,
          cents: 0,
          nonDeductibleCents: 0,
          itemIds: [],
          assetIds: [],
        };
        byLine.set(part.lineKey, line);
      }
      line.cents += part.cents;
      line.nonDeductibleCents += part.nonDeductibleCents;
      if (!line.itemIds.includes(item.id)) line.itemIds.push(item.id);
    }
  }

  const assets: AssetYearResult[] = [];
  for (const asset of facts.assets ?? []) {
    const firstYear = asset.opening ? asset.opening.year : asset.acquisitionDate ? Number(asset.acquisitionDate.slice(0, 4)) : null;
    // The limits and methods that apply are those of the year the asset was bought.
    const assetRules = rulesForYear(firstYear ?? facts.year).rules.assets;
    const found = assetChecks(asset, assetRules);
    if (found.length > 0) {
      // An asset without a date belongs to every year's queue, like a receipt
      // without one; a dated asset only to its own year and the years after.
      if (firstYear === null || firstYear <= facts.year) assets.push({ assetId: asset.id, counted: false, row: null, parts: [], checks: found });
      continue;
    }
    if ((firstYear as number) > facts.year) continue;
    const row = assetSchedule(asset, assetRules, facts.year).find((r) => r.year === facts.year) ?? null;
    const parts = row ? assetYearParts(asset, row) : [];
    assets.push({ assetId: asset.id, counted: true, row, parts, checks: [] });
    for (const part of parts) {
      let line = byLine.get(part.lineKey);
      if (!line) {
        const def = formLine(rules, part.lineKey);
        line = { key: def.key, form: def.form, line: rules.formLinesVerified ? def.line : null, label: def.label, kind: def.kind, cents: 0, nonDeductibleCents: 0, itemIds: [], assetIds: [] };
        byLine.set(part.lineKey, line);
      }
      line.cents += part.cents;
      if (!line.assetIds.includes(asset.id)) line.assetIds.push(asset.id);
    }
  }

  const order = new Map(rules.formLines.map((l, index) => [l.key, index]));
  const lines = [...byLine.values()].sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  const sum = (form: LineResult['form']) =>
    lines.filter((l) => l.form === form && l.kind === 'expense').reduce((total, l) => total + l.cents, 0);

  return {
    year: facts.year,
    rulesYear: rules.year,
    rulesExact: exact,
    formLinesVerified: rules.formLinesVerified,
    lines,
    businessExpenseCents: sum('euer'),
    businessRevenueCents: lines.filter((l) => l.form === 'euer' && l.kind === 'revenue').reduce((total, l) => total + l.cents, 0),
    employmentCostCents: sum('employment'),
    privateCents: items.reduce((total, i) => total + i.privateCents, 0),
    items,
    checks,
    assets,
    assetChecks: assets.flatMap((a) => a.checks),
    countedItems: items.filter((i) => i.counted).length,
    blockedItems: items.filter((i) => !i.counted).length,
  };
}
