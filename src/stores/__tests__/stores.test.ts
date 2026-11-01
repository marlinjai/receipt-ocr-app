import { autorun } from 'mobx';
import { describe, expect, it } from 'vitest';
import type { MealRecord, MealTaxSettings } from '@/lib/meals/types';
import { AppStore } from '../AppStore';
import { MealsStore } from '../MealsStore';

const settings = {} as MealTaxSettings;
const record = (rowId: string, o: Partial<MealRecord> = {}): MealRecord => ({ rowId, host: '', guests: [], ...o }) as MealRecord;
const contact = { id: 'c1', name: 'Neu', companyOrRole: 'Firma', note: null, archived: false };

describe('the meals store', () => {
  const store = (...records: MealRecord[]) => new MealsStore({ records, contacts: [], settings, defaultHost: '' });

  it('replaces a saved record and remembers its host', () => {
    const meals = store(record('a'));
    meals.recordSaved(record('a', { host: ' Gast ' }));
    expect(meals.records[0].host).toBe(' Gast ');
    expect(meals.defaultHost).toBe('Gast');
  });

  it('keeps a saved record out when the page no longer has it, and removes what is gone', () => {
    const meals = store(record('a'), record('b'));
    meals.recordsSaved([record('z')]);
    meals.recordSaved(record('y'));
    meals.recordsRemoved(['a']);
    expect(meals.records.map((r) => r.rowId)).toEqual(['b']);
  });

  it('prints a corrected contact on the meals that name it, and leaves the others the same object', () => {
    const other = record('b');
    const meals = store(record('a', { guests: [{ contactId: 'c1', name: 'Alt', company: '' }] as MealRecord['guests'] }), other);
    meals.contactUpserted(contact);
    expect(meals.records[0].guests[0]).toMatchObject({ name: 'Neu', company: 'Firma' });
    expect(meals.records[1]).toBe(other);
    expect(meals.contacts).toEqual([contact]);
  });
});

describe('the numbers of the navigation', () => {
  const queueOf = (n: number) => ({ queue: { length: n } }) as unknown as MealsStore;

  it('know nothing until something says so', () => {
    expect(new AppStore().counts).toBeNull();
  });

  it('follow the open page, and a server answer leaves that number alone', () => {
    const app = new AppStore();
    const meals = new MealsStore({ records: [], contacts: [], settings, defaultHost: '' });
    const seen: Array<number | undefined> = [];
    const stop = autorun(() => seen.push(app.counts?.meals));
    const close = app.openMeals(meals);
    app.serverCounts({ review: 2, meals: 14 });
    expect(app.counts).toEqual({ review: 2, meals: 0 });
    // An equal answer is no change: nothing observing the numbers redraws.
    const before = seen.length;
    app.serverCounts({ review: 2, meals: 15 });
    expect(seen).toHaveLength(before);
    close();
    stop();
  });

  it('keep the page\'s last number after it closes, until the server speaks', () => {
    const app = new AppStore();
    app.serverCounts({ review: 2, meals: 14 });
    const close = app.openMeals(queueOf(13));
    close();
    expect(app.counts).toEqual({ review: 2, meals: 13 });
    app.serverCounts({ review: 2, meals: 12 });
    expect(app.counts?.meals).toBe(12);
  });

  it('do not let an old page close over a newer one', () => {
    const app = new AppStore();
    const closeOld = app.openMeals(queueOf(1));
    app.openMeals(queueOf(2));
    closeOld();
    expect(app.counts?.meals).toBe(2);
  });

  it('take what a page reports, and keep it when the page closes', () => {
    const app = new AppStore();
    app.report({ review: 5 });
    expect(app.counts).toEqual({ review: 5, meals: 0 });
    app.stopReporting();
    expect(app.counts?.review).toBe(5);
  });
});
