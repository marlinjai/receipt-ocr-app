import { describe, expect, it } from 'vitest';
import { afterLink, bankView, fullStatement, ownNamesView, sharingView } from '@/app/app/finance/__tests__/statement-fixture';
import { FinanceStore } from '../FinanceStore';
import { reuse } from '../reuse';

const store = () => new FinanceStore({ statement: fullStatement(), bank: bankView, sharing: sharingView, ownNames: ownNamesView });

describe('reuse', () => {
  it('reads exactly as the new value, whatever was reused', () => {
    expect(reuse(fullStatement(), afterLink())).toEqual(afterLink());
    expect(reuse(afterLink(), fullStatement())).toEqual(fullStatement());
  });

  it('keeps every record that did not change, also when the list around it shifted', () => {
    const before = fullStatement();
    const next = reuse(before, afterLink());
    expect(next.items.find((i) => i.rowId === 'tel-1')).toBe(before.items.find((i) => i.rowId === 'tel-1'));
    expect(next.items.find((i) => i.rowId === 'year-1')).toBe(before.items.find((i) => i.rowId === 'year-1'));
    expect(next.assets).toBe(before.assets);
    expect(next.revenue).toBe(before.revenue);
    expect(next.payments).not.toBe(before.payments);
    expect(next.payments.accounts).toBe(before.payments.accounts);
  });

  it('an equal value is the old object, and a changed field is never kept', () => {
    const before = fullStatement();
    expect(reuse(before, fullStatement())).toBe(before);
    expect(reuse({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } })).toEqual({ a: 1, b: { c: 3 } });
  });

  it('a field that left, or a null in place of a record, is taken as it comes', () => {
    expect(reuse<Record<string, unknown>>({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 });
    expect(reuse<{ a: { b: number } | null }>({ a: { b: 1 } }, { a: null })).toEqual({ a: null });
    expect(reuse([1, 2, 3], [1, 2])).toEqual([1, 2]);
  });

  it('two records with the same place but other ids are not mixed up', () => {
    const merged = reuse([{ id: 'a', n: 1 }, { id: 'b', n: 2 }], [{ id: 'b', n: 2 }, { id: 'a', n: 1 }]);
    expect(merged).toEqual([{ id: 'b', n: 2 }, { id: 'a', n: 1 }]);
  });
});

describe('the statement', () => {
  it('forward: a newer answer becomes what every tab reads', () => {
    const finance = store();
    finance.took(afterLink());
    expect(finance.statement).toEqual(afterLink());
  });

  it('a late answer cannot overwrite a newer one', () => {
    const finance = store();
    finance.took({ ...afterLink(), readAt: 5 });
    finance.took({ ...fullStatement(), readAt: 3 });
    expect(finance.statement.businessExpenseCents).toBe(afterLink().businessExpenseCents);
  });

  it('an answer of another year keeps its place there and leaves the year on screen as it is', () => {
    const finance = store();
    finance.answered({ ...fullStatement(), year: 2024, readAt: 99, businessExpenseCents: 1 });
    expect(finance.statement.year).toBe(2025);
    expect(finance.statement.businessExpenseCents).toBe(fullStatement().businessExpenseCents);
    finance.pageRead({ statement: { ...fullStatement(), year: 2024, readAt: 3 }, bank: null, sharing: null, ownNames: null });
    expect(finance.statement.businessExpenseCents).toBe(1);
  });

  it('is behind when a write was answered after its read, in any year, and not when it read after that', () => {
    const finance = store();
    expect(finance.behind).toBe(false);
    finance.answered({ ...fullStatement(), year: 2024, readAt: 99 });
    expect(finance.behind).toBe(true);
    finance.took({ ...fullStatement(), readAt: 100 });
    expect(finance.behind).toBe(false);
  });

  it('a plain read is no write: it asks nobody to read again', () => {
    const finance = store();
    finance.took({ ...fullStatement(), year: 2024, readAt: 99 });
    expect(finance.behind).toBe(false);
  });

  it('the same answer twice is no change: nothing reading it redraws', () => {
    const finance = store();
    const before = finance.statement;
    finance.took(fullStatement());
    expect(finance.statement).toBe(before);
  });
});

describe('what is counted from the statement', () => {
  it('follows the statement: the queue, the waiting numbers and the lookups are one source', () => {
    const finance = store();
    expect(finance.queue.map((i) => i.rowId)).toEqual(['open-1', 'open-2', 'open-3', 'open-4', 'year-1']);
    expect(finance.counts).toEqual({ open: 6, questions: 3, assets: 1 });
    expect(finance.openAssets).toBe(1);
    expect(finance.estimated).toBe(1);
    expect(finance.blockedBySetting).toBe(0);
    expect(finance.itemsById.get('line-1:a')?.lineDescription).toBe('Router');
    expect(finance.assetsById.get('asset-1')?.label).toBe('Kamera');
    finance.took(afterLink());
    expect(finance.queue.map((i) => i.rowId)).toEqual(['open-2', 'open-3', 'open-4', 'year-1']);
    expect(finance.counts).toEqual({ open: 5, questions: 2, assets: 1 });
  });
});

describe('what stands beside the statement', () => {
  it('the bank and the sharing follow their own answers and leave the statement alone', () => {
    const finance = store();
    const before = finance.statement;
    finance.bankChanged({ readAt: 2, enabled: true, connections: [] });
    finance.sharingChanged({ ...sharingView, readAt: 2, canWrite: false });
    expect(finance.bank?.connections).toEqual([]);
    expect(finance.sharing?.canWrite).toBe(false);
    expect(finance.statement).toBe(before);
  });

  it('a slow read cannot undo a newer answer, for the bank, the sharing and the names alike', () => {
    const finance = store();
    finance.bankChanged({ readAt: 5, enabled: false, connections: [] });
    finance.sharingChanged({ ...sharingView, readAt: 5, canWrite: false });
    finance.namesChanged(['Neu'], 5);
    finance.pageRead({ statement: fullStatement(), bank: bankView, sharing: sharingView, ownNames: ownNamesView });
    expect(finance.bank?.enabled).toBe(false);
    expect(finance.sharing?.canWrite).toBe(false);
    expect(finance.ownNames?.names).toEqual(['Neu']);
  });

  it('the own names change as a list, and a page that could not read them has none to change', () => {
    const finance = store();
    finance.namesChanged(['Neu'], 2);
    expect(finance.ownNames).toEqual({ readAt: 2, names: ['Neu'], canWrite: true });
    const without = new FinanceStore({ statement: fullStatement(), bank: null, sharing: null, ownNames: null });
    without.namesChanged(['Neu'], 2);
    expect(without.ownNames).toBeNull();
  });
});
