/**
 * Recurring receipts in groups, one per vendor and year.
 *
 * A subscription of twelve invoices, a landline of twelve bills: they become
 * one group per year, which shows their sum, the way the owner's own expense
 * tables and the filed returns count them. It is named "Vendor, Item, Year"
 * while it holds one item, and "Vendor, Year" once it holds several.
 *
 * The rule, as decided by the owner on 2026-10-14 and widened on 2026-10-29 and
 * 2026-10-30:
 *   - the key is the vendor, the year of the invoice date and the assignment,
 *     equal as written (case, spaces and punctuation at the ends do not make two
 *     keys, nothing else is guessed or merged). The item is no part of it: the
 *     reader words one subscription in several ways, and two plans of one vendor
 *     belong together too (2026-10-30: "they can go into one group");
 *   - what recurs is decided by the item: a receipt goes into a group when its
 *     vendor and item appear at least twice in the year, so a one-off purchase
 *     from a shop with a subscription, or two unrelated orders, stay loose;
 *   - every assigned receipt is grouped, private ones too (2026-10-29: "put all
 *     receipts that can be grouped into groups"); the assignment is part of the
 *     key, so a group never mixes business and private money. Unassigned
 *     receipts, business meals (they live in the meal register) and receipts a
 *     person took out of a group are left alone;
 *   - the group of a key is the group whose receipts carry that key, whatever it
 *     is called (a group keeps the name its first receipts gave it, and a vendor
 *     corrected later must not leave the next receipt outside); a group that
 *     holds no receipt yet is found by its name;
 *   - a group is made when two recurring receipts share a key and none exists;
 *     a recurring receipt whose key has a group joins it;
 *   - where one key has several groups that hold nothing but that key, their
 *     receipts move into the largest, and the others, empty, go.
 *
 * Pure: the planner takes plain data and returns what to create, what to join
 * and what to merge, so the rule is tested without a database and applied the
 * same way when a receipt arrives and when a person asks for it.
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
  /** Receipts at the top level that go into the group of their key, and the receipts of other groups of only that key. */
  join: Array<{ groupId: string; memberIds: string[] }>;
  /** Groups that came to hold several items, so the item in their name no longer says what they are. */
  rename: Array<{ groupId: string; name: string }>;
}

/** The assignments whose receipts are grouped: every one there is. An unassigned receipt waits until it has one. */
const GROUPED_ASSIGNMENTS = new Set(['Geschäftlich', 'Universität', 'Privat']);
/** The category of business meals: they are kept in the meal register. */
const MEAL_CATEGORY_NAME = 'Bewirtung';
/** At most this much of the vendor goes into a group's name, so that name, item and year fit the name limit. */
const VENDOR_NAME_MAX = 50;

/** Equal as written: case, inner spaces and spaces at the ends do not make two keys. */
function norm(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('de-DE');
}

/**
 * The name of the group for a vendor, item and year as the first receipt spells them, without the item (null)
 * when it holds several; with `assignment` when the plain name is taken by a group of another key
 * ("OpenAI, ChatGPT Plus, 2024, Privat").
 */
export function groupNameFor(vendor: string, item: string | null, year: number, assignment?: string): string {
  const v = vendor.replace(/\s+/g, ' ').trim().slice(0, VENDOR_NAME_MAX).trim();
  const tail = assignment ? `, ${year}, ${assignment}` : `, ${year}`;
  if (item === null) return `${v}${tail}`;
  // The year always stays: it is the part of the key that the name must carry. The item gives way.
  const room = Math.max(1, GROUP_NAME_MAX - v.length - ', '.length - tail.length);
  const i = item.replace(/\s+/g, ' ').trim().slice(0, room).trim();
  return `${v}, ${i}${tail}`;
}

/** The key of a receipt wherever it lies, or null when it is not to be grouped. */
function keyOf(r: GroupableReceipt): string | null {
  if (r.year === null || !r.vendor?.trim() || !r.item?.trim()) return null;
  if (!r.assignment || !GROUPED_ASSIGNMENTS.has(r.assignment)) return null;
  if (r.category === MEAL_CATEGORY_NAME) return null;
  return `${r.year}|${norm(r.assignment)}|${norm(r.vendor)}`;
}

const itemOf = (r: GroupableReceipt, key: string) => `${key}|${norm(r.item!)}`;

/** The key of a receipt at the top level, or null when it is not to be grouped (also when it lies in a group already). */
export function groupKey(r: GroupableReceipt): string | null {
  return r.parentRowId ? null : keyOf(r);
}

/**
 * What to create and what to join. `receipts` is every receipt that may be
 * grouped, those in groups included (the caller passes the whole table, or the
 * receipts of one year), `only` narrows the plan to the keys of those receipt
 * ids (a receipt that just arrived), `groups` are the groups that exist.
 */
export function planAutoGroups(receipts: readonly GroupableReceipt[], groups: readonly ExistingGroup[], only?: ReadonlySet<string>): GroupPlan {
  const loose = new Map<string, GroupableReceipt[]>();
  /** Per group, its receipts by key; a receipt without a key counts under the empty key, so the group is not pure. */
  const contents = new Map<string, Map<string, string[]>>();
  /** How often each vendor and item appears in its key, in groups or not: what appears twice recurs. */
  const seen = new Map<string, number>();
  for (const r of receipts) {
    const key = keyOf(r);
    if (key !== null) seen.set(itemOf(r, key), (seen.get(itemOf(r, key)) ?? 0) + 1);
    if (r.parentRowId) {
      const byKey = contents.get(r.parentRowId) ?? new Map<string, string[]>();
      byKey.set(key ?? '', [...(byKey.get(key ?? '') ?? []), r.id]);
      contents.set(r.parentRowId, byKey);
    } else if (key !== null) {
      loose.set(key, [...(loose.get(key) ?? []), r]);
    }
  }
  const known = new Set(groups.map((g) => g.id));
  /** Per key, the groups that hold receipts of it: pure ones (nothing but the key) first, then by how many they hold. */
  const holders = new Map<string, Array<{ id: string; count: number; pure: boolean }>>();
  for (const [groupId, byKey] of contents) {
    if (!known.has(groupId)) continue;
    const pure = byKey.size === 1 && !byKey.has('');
    for (const [key, ids] of byKey) {
      if (key === '') continue;
      holders.set(key, [...(holders.get(key) ?? []), { id: groupId, count: ids.length, pure }]);
    }
  }
  for (const list of holders.values()) list.sort((a, b) => Number(b.pure) - Number(a.pure) || b.count - a.count || (a.id < b.id ? -1 : 1));
  const emptyByName = new Map<string, string>();
  for (const g of groups) if (!contents.has(g.id) && !emptyByName.has(norm(g.name))) emptyByName.set(norm(g.name), g.id);
  /** Names a group holding receipts already carries, and names planned in this run. */
  const taken = new Set(groups.filter((g) => contents.has(g.id)).map((g) => norm(g.name)));

  const keys = new Set([...loose.keys(), ...holders.keys()]);
  const wanted = (key: string) => {
    if (!only) return true;
    const ids = [...(loose.get(key) ?? []).map((r) => r.id), ...(holders.get(key) ?? []).flatMap((h) => contents.get(h.id)?.get(key) ?? [])];
    return ids.some((id) => only.has(id));
  };

  const recurs = (r: GroupableReceipt, key: string) => (seen.get(itemOf(r, key)) ?? 0) >= 2;
  const byId = new Map(receipts.map((r) => [r.id, r]));
  /** The one item of these receipts as the first one spells it, null when they hold several. */
  const oneItem = (key: string, list: readonly GroupableReceipt[]): string | null =>
    new Set(list.map((r) => itemOf(r, key))).size === 1 ? list[0].item : null;
  /** The name for these receipts, or null when even the name with the assignment is taken. */
  const freeName = (key: string, list: readonly GroupableReceipt[]): string | null => {
    const first = list[0];
    const item = oneItem(key, list);
    const plain = groupNameFor(first.vendor!, item, first.year!);
    const withAssignment = groupNameFor(first.vendor!, item, first.year!, first.assignment!);
    return [plain, withAssignment].find((n) => !taken.has(norm(n))) ?? null;
  };

  const plan: GroupPlan = { create: [], join: [], rename: [] };
  // Two keys that come to the same name are never put into one group: the second group carries the
  // assignment behind the name (business and private receipts of one vendor and item, or two vendors cut to
  // the same name at its limit). Should even that name be taken, the key waits for a person.
  for (const key of keys) {
    if (!wanted(key)) continue;
    const members = (loose.get(key) ?? []).filter((r) => recurs(r, key));
    const [target, ...others] = holders.get(key) ?? [];
    // Other groups that hold nothing but this key give their receipts to the target; a group a person
    // filled with several keys is theirs and keeps what it holds.
    const merged = target ? others.filter((o) => o.pure).flatMap((o) => contents.get(o.id)?.get(key) ?? []) : [];
    const ids = [...members.map((m) => m.id), ...merged];
    if (target) {
      if (ids.length === 0) continue;
      plan.join.push({ groupId: target.id, memberIds: ids });
      const after = [...(contents.get(target.id)?.get(key) ?? []), ...ids].flatMap((id) => byId.get(id) ?? []);
      if (target.pure && oneItem(key, after) === null) {
        const current = groups.find((g) => g.id === target.id)!.name;
        const name = freeName(key, after);
        if (name && norm(name) !== norm(current)) {
          taken.add(norm(name));
          plan.rename.push({ groupId: target.id, name });
        }
      }
      continue;
    }
    const all = loose.get(key) ?? [];
    if (all.length === 0) continue;
    // A group that holds no receipt yet is found by its name, also by a single receipt.
    const first = all[0];
    const namedFor = [first.item, null].flatMap((item) => [groupNameFor(first.vendor!, item, first.year!), groupNameFor(first.vendor!, item, first.year!, first.assignment!)]);
    const empty = namedFor.map((n) => emptyByName.get(norm(n))).find(Boolean);
    if (empty) {
      plan.join.push({ groupId: empty, memberIds: all.map((m) => m.id) });
      continue;
    }
    if (members.length < 2) continue;
    const name = freeName(key, members);
    if (name) {
      taken.add(norm(name));
      plan.create.push({ name, memberIds: ids });
    }
  }
  return plan;
}
