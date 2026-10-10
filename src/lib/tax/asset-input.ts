import { ASSET_METHODS, type AssetKind, type AssetMethod, type DisposalKind } from './assets';
import { isIsoDay } from './decisions';
import { WHOLE_BP } from './money';

/**
 * What a person states about an asset, and the checks every write passes.
 * Pure. This only checks that the statement is well formed; whether the method
 * is ALLOWED for the cost and date is decided on read by `assetChecks`,
 * because the cost comes from the linked receipts and can change later.
 */

export interface AssetInput {
  label: string;
  kind: AssetKind;
  /** ISO day; required unless the asset is carried in from before the app. */
  acquisitionDate: string | null;
  method: AssetMethod;
  usefulLifeMonths: number | null;
  decliningRateBp: number | null;
  businessShareBp: number;
  reminderCents: number;
  opening: { year: number; bookValueCents: number; remainingMonths: number } | null;
  /** The receipts that make up the cost. */
  rowIds: string[];
}

export interface DisposalInput {
  date: string;
  kind: DisposalKind;
  proceedsCents: number;
}

export type AssetInputErrorCode =
  | 'label_required'
  | 'label_too_long'
  | 'invalid_kind'
  | 'invalid_method'
  | 'invalid_date'
  | 'date_required'
  | 'invalid_useful_life'
  | 'invalid_rate'
  | 'invalid_share'
  | 'invalid_reminder'
  | 'invalid_opening'
  | 'receipts_required'
  | 'receipts_and_opening'
  | 'invalid_disposal';

export class AssetInputError extends Error {
  readonly code: AssetInputErrorCode;
  constructor(code: AssetInputErrorCode) {
    super(code);
    this.name = 'AssetInputError';
    this.code = code;
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
/** Amounts are bounded so a typo cannot overflow the integer columns. */
const MAX_CENTS = 1_000_000_000;

export function validateAssetInput(raw: unknown): AssetInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  const fail = (code: AssetInputErrorCode): never => {
    throw new AssetInputError(code);
  };

  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label) fail('label_required');
  if (label.length > 200) fail('label_too_long');
  if (input.kind !== 'movable' && input.kind !== 'intangible') fail('invalid_kind');
  if (typeof input.method !== 'string' || !(ASSET_METHODS as readonly string[]).includes(input.method)) fail('invalid_method');
  const method = input.method as AssetMethod;

  let opening: AssetInput['opening'] = null;
  if (input.opening !== null && input.opening !== undefined) {
    const o = input.opening as Record<string, unknown>;
    if (
      !isInt(o.year) || o.year < 1990 || o.year > 2100 ||
      !isInt(o.bookValueCents) || o.bookValueCents < 0 || o.bookValueCents > MAX_CENTS ||
      !isInt(o.remainingMonths) || o.remainingMonths < 0 || o.remainingMonths > 1200
    ) {
      fail('invalid_opening');
    }
    opening = { year: o.year as number, bookValueCents: o.bookValueCents as number, remainingMonths: o.remainingMonths as number };
  }

  const acquisitionDate = input.acquisitionDate === null || input.acquisitionDate === undefined || input.acquisitionDate === '' ? null : input.acquisitionDate;
  if (acquisitionDate !== null && !isIsoDay(acquisitionDate)) fail('invalid_date');
  if (acquisitionDate === null && opening === null) fail('date_required');

  const usefulLifeMonths = input.usefulLifeMonths === null || input.usefulLifeMonths === undefined ? null : input.usefulLifeMonths;
  if (usefulLifeMonths !== null && (!isInt(usefulLifeMonths) || usefulLifeMonths < 1 || usefulLifeMonths > 1200)) fail('invalid_useful_life');
  const decliningRateBp = input.decliningRateBp === null || input.decliningRateBp === undefined ? null : input.decliningRateBp;
  if (decliningRateBp !== null && (!isInt(decliningRateBp) || decliningRateBp < 1 || decliningRateBp > WHOLE_BP)) fail('invalid_rate');

  const businessShareBp = input.businessShareBp === undefined ? WHOLE_BP : input.businessShareBp;
  if (!isInt(businessShareBp) || businessShareBp < 1 || businessShareBp > WHOLE_BP) fail('invalid_share');
  const reminderCents = input.reminderCents === undefined ? 0 : input.reminderCents;
  if (!isInt(reminderCents) || reminderCents < 0 || reminderCents > 100) fail('invalid_reminder');

  const rowIds = Array.isArray(input.rowIds) ? [...new Set(input.rowIds.filter((id): id is string => typeof id === 'string' && id.length > 0))] : [];
  // The cost of a new asset IS its receipts; a carried-in asset has a stated
  // book value instead and takes no receipts, or its cost would count twice.
  if (opening === null && rowIds.length === 0) fail('receipts_required');
  if (opening !== null && rowIds.length > 0) fail('receipts_and_opening');
  if (rowIds.length > 50) fail('receipts_required');

  return {
    label,
    kind: input.kind as AssetKind,
    acquisitionDate: acquisitionDate as string | null,
    method,
    // A value that plays no role for the method is not stored.
    usefulLifeMonths: method === 'linear' || method === 'declining' ? (usefulLifeMonths as number | null) : null,
    decliningRateBp: method === 'declining' ? (decliningRateBp as number | null) : null,
    businessShareBp: businessShareBp as number,
    reminderCents: reminderCents as number,
    opening,
    rowIds,
  };
}

export function validateDisposalInput(raw: unknown): DisposalInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  const kind = input.kind;
  if (!isIsoDay(input.date) || (kind !== 'sold' && kind !== 'scrapped' && kind !== 'private')) {
    throw new AssetInputError('invalid_disposal');
  }
  const proceeds = input.proceedsCents === undefined || input.proceedsCents === null ? 0 : input.proceedsCents;
  if (!isInt(proceeds) || proceeds < 0 || proceeds > MAX_CENTS) throw new AssetInputError('invalid_disposal');
  // Something scrapped brought nothing in; a stated amount would be a contradiction.
  if (kind === 'scrapped' && proceeds !== 0) throw new AssetInputError('invalid_disposal');
  return { date: input.date, kind, proceedsCents: proceeds };
}
