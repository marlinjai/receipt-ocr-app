import { parseAllocations, type TreatmentInput } from './decisions';
import { isFormLineKey } from './rules/types';

/**
 * Receipt lines: a receipt split into its positions, because they are treated
 * differently (one business and one private; one an asset and one not). Pure.
 *
 * The lines of a receipt add up to its total, in the receipt's own currency.
 * That is checked when lines are saved and again on every read, since the
 * receipt's total can be corrected afterwards.
 */

export interface ReceiptLine {
  id: string;
  position: number;
  description: string;
  /** In the receipt's own currency, cents. */
  grossCents: number;
  netCents: number | null;
  /** Null: the line is treated like its receipt. */
  treatment: TreatmentInput | null;
}

export interface LineInput {
  /** The id of an existing line to keep (with its decision and its place in an asset); absent for a new line. */
  id?: string;
  description: string;
  grossCents: number;
  netCents: number | null;
}

export type LinesInputErrorCode =
  | 'lines_required'
  | 'too_many_lines'
  | 'line_description_required'
  | 'line_description_too_long'
  | 'invalid_line_amount'
  | 'invalid_line_net'
  | 'lines_do_not_sum'
  | 'receipt_without_total'
  | 'duplicate_line';

export class LinesInputError extends Error {
  readonly code: LinesInputErrorCode;
  constructor(code: LinesInputErrorCode) {
    super(code);
    this.name = 'LinesInputError';
    this.code = code;
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * Check lines against the receipt's total (in the receipt's currency, cents).
 * A split needs at least two lines; one line would be the receipt itself.
 */
export function validateLines(raw: unknown, receiptGrossCents: number | null): LineInput[] {
  const fail = (code: LinesInputErrorCode): never => {
    throw new LinesInputError(code);
  };
  if (receiptGrossCents === null || receiptGrossCents <= 0) fail('receipt_without_total');
  const list = Array.isArray(raw) ? raw : [];
  if (list.length < 2) fail('lines_required');
  if (list.length > 50) fail('too_many_lines');
  const seen = new Set<string>();
  const lines = list.map((entry): LineInput => {
    const line = (entry ?? {}) as Record<string, unknown>;
    const description = typeof line.description === 'string' ? line.description.trim() : '';
    if (!description) fail('line_description_required');
    if (description.length > 200) fail('line_description_too_long');
    if (!isInt(line.grossCents) || line.grossCents <= 0) fail('invalid_line_amount');
    const net = line.netCents === undefined || line.netCents === null ? null : line.netCents;
    if (net !== null && (!isInt(net) || net <= 0 || net > (line.grossCents as number))) fail('invalid_line_net');
    const id = typeof line.id === 'string' && line.id ? line.id : undefined;
    if (id) {
      if (seen.has(id)) fail('duplicate_line');
      seen.add(id);
    }
    return { ...(id ? { id } : {}), description, grossCents: line.grossCents as number, netCents: net as number | null };
  });
  if (lines.reduce((s, l) => s + l.grossCents, 0) !== receiptGrossCents) fail('lines_do_not_sum');
  return lines;
}

/** Do the lines still add up to the receipt's total? */
export function linesMatchTotal(lines: readonly Pick<ReceiptLine, 'grossCents'>[], receiptGrossCents: number | null): boolean {
  return receiptGrossCents !== null && lines.reduce((s, l) => s + l.grossCents, 0) === receiptGrossCents;
}

/**
 * Spread an amount over the lines in the proportion of their gross amounts,
 * as differences of cumulative figures, so the parts always add up to exactly
 * the amount. Used to carry the euro amount of a receipt (converted, or as
 * actually paid) down to its lines.
 */
export function spreadOverLines(amountCents: number, lines: readonly Pick<ReceiptLine, 'grossCents'>[]): number[] {
  const total = lines.reduce((s, l) => s + l.grossCents, 0);
  if (total <= 0) return lines.map(() => 0);
  let before = 0;
  let cumulative = 0;
  return lines.map((line) => {
    cumulative += line.grossCents;
    const after = Math.round((amountCents * cumulative) / total);
    const part = after - before;
    before = after;
    return part;
  });
}

/** Read a line's own decision from its stored columns; null when it has none or it no longer parses. */
export function storedLineTreatment(row: { allocations: unknown; formLineKey: string | null; employmentLineKey: string | null }): TreatmentInput | null {
  if (row.allocations === null || row.allocations === undefined) return null;
  const allocations = parseAllocations(row.allocations);
  if (allocations === null) return null;
  if (row.formLineKey !== null && !isFormLineKey(row.formLineKey)) return null;
  if (row.employmentLineKey !== null && !isFormLineKey(row.employmentLineKey)) return null;
  return {
    allocations,
    formLineKey: row.formLineKey as TreatmentInput['formLineKey'],
    employmentLineKey: row.employmentLineKey as TreatmentInput['employmentLineKey'],
  };
}

/** The id of an item in the statement: the receipt's row id, or row and line for a line. */
export function itemIdOf(rowId: string, lineId: string | null): string {
  return lineId ? `${rowId}#${lineId}` : rowId;
}

export function splitItemId(itemId: string): { rowId: string; lineId: string | null } {
  const at = itemId.indexOf('#');
  return at === -1 ? { rowId: itemId, lineId: null } : { rowId: itemId.slice(0, at), lineId: itemId.slice(at + 1) };
}
