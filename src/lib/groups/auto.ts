/**
 * Recurring receipts in groups, by vendor and item per year, exactly.
 *
 * A subscription of twelve invoices, a landline of twelve bills: they become
 * one group per year, named "Vendor, Item, Year", which shows their sum, the
 * way the owner's own expense tables and the filed returns count them.
 *
 * The rule, as decided by the owner on 2026-10-14:
 *   - the key is the vendor, the item and the year of the invoice date, equal
 *     as written (case, spaces and punctuation at the ends do not make two
 *     keys, nothing else is guessed or merged);
 *   - only receipts that count for tax are grouped: assignment business or
 *     university. Private and unassigned receipts, business meals (they live
 *     in the meal register) and receipts already in a group are left alone;
 *   - a group is made when two receipts share a key; a receipt whose key has
 *     a group already joins it.
 *
 * Pure: the planner takes plain data and returns what to create and what to
 * join, so the rule is tested without a database and applied the same way
 * when a receipt arrives and when a person asks for it.
 */

import { GROUP_NAME_MAX } from './rules';

export interface GroupableReceipt {
  id: string;
  vendor: string | null;
  item: string | null;
  /** The year of the invoice day, null when the receipt has no date. */
  year: number | null;
  /** The assignment by name ("Geschäftlich", "Universität", "Privat"), null when empty. */
  assignment: string | null;
  /** The category by name. */
  category: string | null;
  /** The group the receipt lies in, null at the top level. */
  parentRowId: string | null;
}

export interface ExistingGroup {
  id: string;
  name: string;
}

export interface GroupPlan {
  create: Array<{ name: string; memberIds: string[] }>;
  join: Array<{ groupId: string; memberIds: string[] }>;
}

const COUNTED_ASSIGNMENTS = new Set(['Geschäftlich', 'Universität']);
/** The category of business meals: they are kept in the meal register. */
const MEAL_CATEGORY_NAME = 'Bewirtung';
/** At most this much of the vendor goes into a group's name, so that name, item and year fit the name limit. */
const VENDOR_NAME_MAX = 50;

/** Equal as written: case, inner spaces and spaces at the ends do not make two keys. */
function norm(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('de-DE');
}

/** The name of the group for a vendor, item and year as the first receipt spells them. */
export function groupNameFor(vendor: string, item: string, year: number): string {
  const v = vendor.replace(/\s+/g, ' ').trim().slice(0, VENDOR_NAME_MAX).trim();
  const i = item.replace(/\s+/g, ' ').trim();
  return `${v}, ${i}, ${year}`.slice(0, GROUP_NAME_MAX);
}

/** The key of a receipt, or null when it is not to be grouped. */
export function groupKey(r: GroupableReceipt): string | null {
  if (r.parentRowId) return null;
  if (r.year === null || !r.vendor?.trim() || !r.item?.trim()) return null;
  if (!r.assignment || !COUNTED_ASSIGNMENTS.has(r.assignment)) return null;
  if (r.category === MEAL_CATEGORY_NAME) return null;
  return `${r.year}|${norm(r.vendor)}|${norm(r.item)}`;
}

/**
 * What to create and what to join. `receipts` is every receipt that may be
 * grouped (the caller passes the whole table, or the receipts of one year),
 * `only` narrows the plan to the keys of those receipt ids (a receipt that
 * just arrived), `groups` are the groups that exist.
 */
export function planAutoGroups(receipts: readonly GroupableReceipt[], groups: readonly ExistingGroup[], only?: ReadonlySet<string>): GroupPlan {
  const byKey = new Map<string, GroupableReceipt[]>();
  for (const r of receipts) {
    const key = groupKey(r);
    if (key === null) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const groupByName = new Map<string, string>();
  for (const g of groups) if (!groupByName.has(norm(g.name))) groupByName.set(norm(g.name), g.id);

  const plan: GroupPlan = { create: [], join: [] };
  for (const members of byKey.values()) {
    if (only && !members.some((m) => only.has(m.id))) continue;
    const first = members[0];
    const name = groupNameFor(first.vendor!, first.item!, first.year!);
    const existing = groupByName.get(norm(name));
    const ids = members.map((m) => m.id);
    if (existing) plan.join.push({ groupId: existing, memberIds: ids });
    else if (members.length >= 2) plan.create.push({ name, memberIds: ids });
  }
  return plan;
}
