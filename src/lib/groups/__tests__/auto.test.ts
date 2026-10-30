import { describe, expect, it } from 'vitest';
import { groupKey, groupNameFor, planAutoGroups, type GroupableReceipt } from '../auto';

let n = 0;
const r = (over: Partial<GroupableReceipt> = {}): GroupableReceipt => ({
  id: `r${++n}`,
  vendor: 'OpenAI',
  item: 'ChatGPT Plus',
  year: 2024,
  assignment: 'Geschäftlich',
  category: 'Software & Lizenzen',
  parentRowId: null,
  ...over,
});

describe('which receipts are grouped', () => {
  it('every assigned receipt with vendor, item and a date, outside groups and meals, private ones too', () => {
    expect(groupKey(r())).toBe('2024|geschäftlich|openai');
    expect(groupKey(r({ assignment: 'Universität' }))).not.toBeNull();
    expect(groupKey(r({ assignment: 'Privat' }))).toBe('2024|privat|openai');
    expect(groupKey(r({ assignment: null }))).toBeNull();
    expect(groupKey(r({ category: 'Bewirtung' }))).toBeNull();
    expect(groupKey(r({ parentRowId: 'g1' }))).toBeNull();
    expect(groupKey(r({ item: null }))).toBeNull();
    expect(groupKey(r({ item: '  ' }))).toBeNull();
    expect(groupKey(r({ vendor: '' }))).toBeNull();
    expect(groupKey(r({ year: null }))).toBeNull();
  });

  it('is exact about the vendor: case and spacing do not make two keys, another year or assignment does, the item does not', () => {
    expect(groupKey(r({ vendor: ' openai ', item: 'ChatGPT  PLUS' }))).toBe(groupKey(r()));
    expect(groupKey(r({ item: 'ChatGPT Plus Abo' }))).toBe(groupKey(r()));
    expect(groupKey(r({ vendor: 'OpenAI Ireland' }))).not.toBe(groupKey(r()));
    expect(groupKey(r({ year: 2025 }))).not.toBe(groupKey(r()));
    expect(groupKey(r({ assignment: 'Privat' }))).not.toBe(groupKey(r()));
  });
});

describe('the plan', () => {
  it('creates one group per vendor and year, named by the item while there is one', () => {
    const a = [r(), r(), r(), r({ year: 2025 }), r({ vendor: 'Adobe', item: 'Creative Cloud' }), r({ vendor: 'Adobe', item: 'Creative Cloud' })];
    const plan = planAutoGroups(a, []);
    expect(plan.join).toEqual([]);
    expect(plan.create.map((c) => c.name).sort()).toEqual(['Adobe, Creative Cloud, 2024', 'OpenAI, ChatGPT Plus, 2024']);
    expect(plan.create.find((c) => c.name === 'OpenAI, ChatGPT Plus, 2024')!.memberIds).toEqual([a[0].id, a[1].id, a[2].id]);
  });

  it('puts two recurring items of a vendor into one group, named by the vendor', () => {
    const a = [r(), r(), r({ item: 'API credits' }), r({ item: 'API credits' })];
    const plan = planAutoGroups(a, []);
    expect(plan.create).toEqual([{ name: 'OpenAI, 2024', memberIds: a.map((x) => x.id) }]);
  });

  it('leaves a one-off purchase from a vendor with a subscription, and unrelated orders, loose', () => {
    const plan = planAutoGroups([r(), r(), r({ item: 'T-Shirt' })], []);
    expect(plan.create[0].memberIds).toHaveLength(2);
    expect(planAutoGroups([r({ item: 'Kabel' }), r({ item: 'Tasche' })], [])).toEqual({ create: [], join: [], rename: [] });
  });

  it('merges two groups of one vendor and year whatever their wording, and names the result by the vendor', () => {
    const big = [r({ item: 'Patreon-Mitgliedschaft', vendor: 'Patreon', parentRowId: 'g1' }), r({ item: 'Patreon-Mitgliedschaft', vendor: 'Patreon', parentRowId: 'g1' }), r({ item: 'Patreon-Mitgliedschaft', vendor: 'Patreon', parentRowId: 'g1' })];
    const small = [r({ item: 'Patreon-Abo', vendor: 'Patreon', parentRowId: 'g2' }), r({ item: 'Patreon-Abo', vendor: 'Patreon', parentRowId: 'g2' })];
    const plan = planAutoGroups([...big, ...small], [
      { id: 'g1', name: 'Patreon, Patreon-Mitgliedschaft, 2026' },
      { id: 'g2', name: 'Patreon, Patreon-Abo, 2026' },
    ]);
    expect(plan.create).toEqual([]);
    expect(plan.join).toEqual([{ groupId: 'g1', memberIds: small.map((x) => x.id) }]);
    expect(plan.rename).toEqual([{ groupId: 'g1', name: 'Patreon, 2024' }]);
  });

  it('merges groups of different plans, but never business with private or one year with another', () => {
    const business = [r({ item: 'Starter', parentRowId: 'g1' }), r({ item: 'Standard', parentRowId: 'g2' })];
    const other = [r({ item: 'Starter', assignment: 'Privat', parentRowId: 'g3' }), r({ item: 'Starter', year: 2025, parentRowId: 'g4' })];
    const plan = planAutoGroups([...business, ...other], ['g1', 'g2', 'g3', 'g4'].map((id) => ({ id, name: id })));
    expect(plan.join).toEqual([{ groupId: 'g1', memberIds: [business[1].id] }]);
  });

  it('merges once: a second run with one group finds nothing to do, also when it holds several items', () => {
    const a = [r({ parentRowId: 'g1' }), r({ item: 'API credits', parentRowId: 'g1' })];
    expect(planAutoGroups(a, [{ id: 'g1', name: 'OpenAI, 2024' }])).toEqual({ create: [], join: [], rename: [] });
  });

  it('renames a group a new plan joins, and keeps the name of a hand-mixed group', () => {
    const inGroup = [r({ item: 'Pro', parentRowId: 'g1' }), r({ item: 'Pro', parentRowId: 'g1' })];
    const newPlan = [r({ item: 'Ultra' }), r({ item: 'Ultra' })];
    const plan = planAutoGroups([...inGroup, ...newPlan], [{ id: 'g1', name: 'OpenAI, Pro, 2024' }]);
    expect(plan.join).toEqual([{ groupId: 'g1', memberIds: newPlan.map((x) => x.id) }]);
    expect(plan.rename).toEqual([{ groupId: 'g1', name: 'OpenAI, 2024' }]);

    const mixed = [r({ item: 'Pro', parentRowId: 'g2' }), r({ vendor: 'Adobe', item: 'CC', parentRowId: 'g2' })];
    expect(planAutoGroups([...mixed, r({ item: 'Pro' })], [{ id: 'g2', name: 'Messe' }]).rename).toEqual([]);
  });

  it('leaves a receipt alone whose key has no second receipt and no group', () => {
    expect(planAutoGroups([r(), r({ vendor: 'Adobe' })], [])).toEqual({ create: [], join: [], rename: [] });
  });

  it('puts a receipt into the group of its key, also a single one', () => {
    const a = r();
    const plan = planAutoGroups([a], [{ id: 'g9', name: 'openai, chatgpt plus, 2024' }]);
    expect(plan).toEqual({ create: [], join: [{ groupId: 'g9', memberIds: [a.id] }], rename: [] });
  });

  it('is idempotent: receipts already in the group are not planned again', () => {
    const inGroup = [r({ parentRowId: 'g9' }), r({ parentRowId: 'g9' })];
    expect(planAutoGroups(inGroup, [{ id: 'g9', name: 'OpenAI, ChatGPT Plus, 2024' }])).toEqual({ create: [], join: [], rename: [] });
  });

  it('finds the group of a key by the receipts in it, whatever the group is called', () => {
    // The group kept the vendor its first receipts had; the vendor was corrected on them since.
    const inGroup = [r({ vendor: 'Apple', item: 'iCloud+ 2 TB', parentRowId: 'g1' }), r({ vendor: 'Apple', item: 'iCloud+ 2 TB', parentRowId: 'g1' })];
    const august = r({ vendor: 'Apple', item: 'iCloud+ 2 TB' });
    const plan = planAutoGroups([...inGroup, august], [{ id: 'g1', name: 'Apple Distribution International Ltd., iCloud+ 2 TB, 2024' }]);
    expect(plan).toEqual({ create: [], join: [{ groupId: 'g1', memberIds: [august.id] }], rename: [] });
  });

  it('groups private receipts apart from business ones of the same vendor and item', () => {
    const work = [r(), r()];
    const home = [r({ assignment: 'Privat' }), r({ assignment: 'Privat' })];
    const plan = planAutoGroups([...work, ...home], []);
    // Both keys come to one name: the second group carries its assignment behind it.
    expect(plan.create).toEqual([
      { name: 'OpenAI, ChatGPT Plus, 2024', memberIds: work.map((w) => w.id) },
      { name: 'OpenAI, ChatGPT Plus, 2024, Privat', memberIds: home.map((h) => h.id) },
    ]);
    // With the business group there already, the private receipts never join it.
    const withGroup = planAutoGroups([...work.map((w) => ({ ...w, parentRowId: 'gw' })), ...home], [{ id: 'gw', name: 'OpenAI, ChatGPT Plus, 2024' }]);
    expect(withGroup).toEqual({ create: [{ name: 'OpenAI, ChatGPT Plus, 2024, Privat', memberIds: home.map((h) => h.id) }], join: [], rename: [] });
  });

  it('moves the receipts of a second group of only that key into the larger one', () => {
    const big = [r({ parentRowId: 'g1' }), r({ parentRowId: 'g1' }), r({ parentRowId: 'g1' })];
    const small = [r({ parentRowId: 'g2' })];
    const loose = r();
    const plan = planAutoGroups([...big, ...small, loose], [
      { id: 'g1', name: 'OpenAI, ChatGPT Plus, 2024' },
      { id: 'g2', name: 'OpenAI, ChatGPT Plus Abo, 2024' },
    ]);
    expect(plan).toEqual({ create: [], join: [{ groupId: 'g1', memberIds: [loose.id, small[0].id] }], rename: [] });
  });

  it('leaves a group a person filled with several keys as it is, and still puts loose receipts into the pure one', () => {
    const pure = [r({ parentRowId: 'g1' }), r({ parentRowId: 'g1' })];
    const mixed = [r({ parentRowId: 'g2' }), r({ vendor: 'Adobe', item: 'Creative Cloud', parentRowId: 'g2' })];
    const loose = r();
    const plan = planAutoGroups([...pure, ...mixed, loose], [
      { id: 'g1', name: 'OpenAI, ChatGPT Plus, 2024' },
      { id: 'g2', name: 'Messe' },
    ]);
    expect(plan).toEqual({ create: [], join: [{ groupId: 'g1', memberIds: [loose.id] }], rename: [] });
  });

  it('counts a receipt without a key as making its group mixed', () => {
    const group = [r({ parentRowId: 'g1' }), r({ assignment: null, parentRowId: 'g1' })];
    const other = [r({ parentRowId: 'g2' })];
    const plan = planAutoGroups([...group, ...other], [
      { id: 'g1', name: 'A' },
      { id: 'g2', name: 'B' },
    ]);
    // g2 is pure and the target; g1 is a person's mixed group and gives nothing up.
    expect(plan).toEqual({ create: [], join: [], rename: [] });
  });

  it('narrows to the keys of the receipts that just arrived', () => {
    const adobe = [r({ vendor: 'Adobe', item: 'Creative Cloud' }), r({ vendor: 'Adobe', item: 'Creative Cloud' })];
    const chat = [r(), r()];
    const plan = planAutoGroups([...adobe, ...chat], [], new Set([chat[1].id]));
    expect(plan.create.map((c) => c.name)).toEqual(['OpenAI, ChatGPT Plus, 2024']);
  });

  it('keeps the name inside the limit', () => {
    const long = groupNameFor('V'.repeat(200), 'Plan', 2024);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith(', Plan, 2024')).toBe(true);
  });

  it('keeps the year in the name when the item is long, so two years never share a group', () => {
    const item = 'x'.repeat(100);
    expect(groupNameFor('Vendor', item, 2024).endsWith(', 2024')).toBe(true);
    expect(groupNameFor('Vendor', item, 2024).length).toBeLessThanOrEqual(120);
    expect(groupNameFor('Vendor', item, 2024)).not.toBe(groupNameFor('Vendor', item, 2025));
  });

  it('never puts two keys that come to the same name into one group', () => {
    const vendor = 'V'.repeat(60);
    const a = [r({ vendor: vendor + 'a' }), r({ vendor: vendor + 'a' })];
    const b = [r({ vendor: vendor + 'b' }), r({ vendor: vendor + 'b' })];
    const plan = planAutoGroups([...a, ...b], []);
    expect(plan.create.map((c) => c.memberIds)).toEqual([a.map((x) => x.id), b.map((x) => x.id)]);
    expect(new Set(plan.create.map((c) => c.name)).size).toBe(2);
  });
});
