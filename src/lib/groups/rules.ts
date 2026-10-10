import type { Column } from '@marlinjai/data-table-core';
import { GROUP_KIND, GROUP_WRITABLE_COLUMNS, ROW_KIND_COLUMN } from '@/lib/receipts-kind';

/**
 * The rules of groups in the receipts table, as pure functions: what may lie in
 * a group, and which cells a group may carry. The service applies them against
 * the database; they are kept apart so every case is tested without one.
 */

export type GroupErrorCode =
  /** The workspace has no Receipts table yet, or the table has not received the kind column. */
  | 'not_initialized'
  /** The group named is not a group of this workspace (deleted, archived, or a receipt). */
  | 'group_not_found'
  /** A row named is not a row of this workspace's table. */
  | 'row_not_found'
  /** A group was asked to go into a group. Groups have one level. */
  | 'group_in_group'
  /** The name is empty or too long. */
  | 'invalid_name'
  /** A cell was written that a group cannot carry (an amount, a date, a file), or the kind itself. */
  | 'not_writable';

export class GroupError extends Error {
  readonly code: GroupErrorCode;
  constructor(code: GroupErrorCode) {
    super(code);
    this.name = 'GroupError';
    this.code = code;
  }
}

export const GROUP_NAME_MAX = 120;

/** The name as it is stored, or an error when nothing is left of it. */
export function cleanGroupName(name: unknown): string {
  const clean = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!clean || clean.length > GROUP_NAME_MAX) throw new GroupError('invalid_name');
  return clean;
}

export interface MemberCandidate {
  id: string;
  kind: string | null;
  /** The group the row lies in, null at the top level. Optional: a caller that does not read it sees no archived row as a member. */
  parentRowId?: string | null;
  archived?: boolean;
}

/**
 * Check the rows that are to go into a group: every one must exist in the
 * table, and none may be a group itself. An archived receipt is not taken in,
 * except one that already lies in the group `targetGroupId` (a repeated move
 * stays a no-op). Throws on the first violation, so a move is all or nothing.
 */
export function assertCanJoinGroup(
  requestedIds: readonly string[],
  found: ReadonlyMap<string, MemberCandidate>,
  targetGroupId?: string,
): void {
  for (const id of requestedIds) {
    const row = found.get(id);
    if (!row) throw new GroupError('row_not_found');
    if (row.archived && (targetGroupId === undefined || row.parentRowId !== targetGroupId)) throw new GroupError('row_not_found');
    if (row.kind === GROUP_KIND) throw new GroupError('group_in_group');
  }
}

/**
 * Check a write of cells against the kind of the row it goes to.
 *
 * - The kind column is never written through a cell edit, on any row: turning a
 *   receipt into a group by an edit would silently take it out of every total.
 * - A group takes its name and the columns the views sort by, nothing else. No
 *   amount can therefore ever be stored on a group.
 */
export function assertCellsWritable(columns: readonly Pick<Column, 'id' | 'name'>[], rowKind: string | null, cells: Readonly<Record<string, unknown>>): void {
  const nameById = new Map(columns.map((c) => [c.id, c.name]));
  for (const columnId of Object.keys(cells)) {
    const name = nameById.get(columnId);
    if (name === ROW_KIND_COLUMN) throw new GroupError('not_writable');
    if (rowKind === GROUP_KIND && name !== undefined && !GROUP_WRITABLE_COLUMNS.includes(name)) throw new GroupError('not_writable');
  }
}

/**
 * The value all rows share in a column, or null when they differ or one has
 * none. A new group made from receipts of one category starts in that
 * category's section, so it appears where its receipts were.
 */
export function sharedValue(values: readonly unknown[]): string | null {
  if (values.length === 0) return null;
  const first = values[0];
  if (typeof first !== 'string' || !first) return null;
  return values.every((v) => v === first) ? first : null;
}
