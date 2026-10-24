import { estimateIncomeTax, type EstimateInput } from '../estimate';
import type { ReturnItemFact } from '../return-items';
import type { IncomeTaxView } from '../service';
import { aggregateWages, type WageEntry } from '../wages';

/**
 * An income tax view as the service would build it, for screen tests: the
 * estimate is computed by the real code from the entries given, so a screen
 * test never shows a figure the estimate could not produce.
 */
export function incomeTaxView(
  options: {
    year?: number;
    running?: boolean;
    wageEntries?: WageEntry[];
    returnItems?: ReturnItemFact[];
    churchMonths?: boolean[] | null;
    federalState?: IncomeTaxView['federalState'];
    filedOn?: string | null;
    profitCents?: number | null;
    project?: boolean;
  } = {},
): IncomeTaxView {
  const year = options.year ?? 2026;
  const wageEntries = options.wageEntries ?? [];
  const returnItems = options.returnItems ?? [];
  const churchMonths = options.churchMonths ?? null;
  const input = (project: boolean): EstimateInput => ({
    year,
    businessProfitCents: options.profitCents === undefined ? null : options.profitCents,
    wages: aggregateWages(wageEntries, project),
    employmentReceiptsCents: 0,
    returnItems,
    churchMonths,
    churchMonthsBasis: churchMonths ? 'stated' : null,
    federalState: options.federalState ?? null,
  });
  return {
    year,
    running: options.running ?? false,
    wageEntries,
    returnItems,
    churchMonths,
    churchMonthsFromPaySlips: null,
    federalState: options.federalState ?? null,
    filedOn: options.filedOn ?? null,
    estimate: estimateIncomeTax(input(false)),
    projected: options.project ? estimateIncomeTax(input(true)) : null,
  };
}
