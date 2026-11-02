import { describe, expect, it } from 'vitest';
import { meal, SMALL_BUSINESS } from '@/lib/meals/__tests__/fixtures';
import type { MealBatchResult } from '@/lib/meals/batch';
import type { MealRecord } from '@/lib/meals/types';
import { AppStore } from '../AppStore';
import { MealsOutbox } from '../MealsOutbox';
import { MealsStore } from '../MealsStore';

const open = (rowId: string, o: Partial<MealRecord> = {}) => meal({ rowId, guests: [], occasion: '', ...o });
const seed = (records: MealRecord[], readAt = 0) => ({ records, contacts: [], settings: SMALL_BUSINESS, defaultHost: '', readAt });
const result = (o: Partial<MealBatchResult>): MealBatchResult => ({ done: [], records: [], skipped: [], at: 10, ...o });
const notMeal = (r: MealRecord): MealRecord => ({ ...r, mealType: 'not_a_meal' });
const restored = (r: MealRecord): MealRecord => ({ ...r, mealType: 'business_meal_external' });

/** A store opened on the app's store, as `MealsClient` opens it. */
function page(records: MealRecord[]) {
  const app = new AppStore();
  const store = new MealsStore(seed(records), app.mealOutbox);
  const close = app.openMeals(store);
  return { app, store, close };
}

describe('a list action, forward', () => {
  it('moves the receipt and the navigation number at once, before any answer', () => {
    const { app, store } = page([open('a'), open('b')]);
    expect(app.counts?.meals).toBe(2);
    store.begin('not_meal', ['a']);
    expect(app.counts?.meals).toBe(1);
    expect(store.queue.map((e) => e.record.rowId)).toEqual(['b']);
    expect(store.dismissed.map((r) => r.rowId)).toEqual(['a']);
  });

  it('takes the record the server answered with, and leaves the others the same object', () => {
    const a = open('a');
    const b = open('b');
    const { store } = page([a, b]);
    const write = store.begin('not_meal', ['a'])!;
    store.answered(write, result({ done: ['a'], records: [{ ...notMeal(a), place: 'vom Server' }] }));
    expect(store.dismissed[0].place).toBe('vom Server');
    expect(store.records[1]).toBe(b);
  });

  it('a delete takes the receipt off the list, and its answer keeps it off', () => {
    const { store } = page([open('a'), open('b')]);
    const write = store.begin('delete', ['a'])!;
    expect(store.records.map((r) => r.rowId)).toEqual(['b']);
    store.answered(write, result({ done: ['a'] }));
    expect(store.records.map((r) => r.rowId)).toEqual(['b']);
  });

  it('a second click on the same receipt means nothing', () => {
    const { store, app } = page([open('a')]);
    store.begin('not_meal', ['a']);
    expect(store.begin('not_meal', ['a'])).toBeNull();
    expect(app.mealOutbox.writes).toHaveLength(1);
  });
});

describe('a refusal', () => {
  it('rolls that record back, in its old place, and always says so', () => {
    const { app, store } = page([open('a'), open('b'), open('c')]);
    const write = store.begin('delete', ['b'])!;
    store.refused(write, 'Lokal B', 'Dafür fehlt die Berechtigung.');
    expect(store.records.map((r) => r.rowId)).toEqual(['a', 'b', 'c']);
    expect(app.counts?.meals).toBe(3);
    expect(app.looseRefusals.map((r) => r.message)).toEqual(['Dafür fehlt die Berechtigung.']);
    expect(app.mealOutbox.writes).toEqual([]);
  });

  it('leaves another write on the same receipts standing', () => {
    const { store } = page([open('a')]);
    const first = store.begin('not_meal', ['a'])!;
    store.begin('restore', ['a']);
    store.begin('not_meal', ['a']);
    store.refused(first, null, 'nein');
    expect(store.dismissed.map((r) => r.rowId)).toEqual(['a']);
  });

  it('per receipt: what the server did stays, what it left alone comes back', () => {
    const { store } = page([open('a'), open('b'), open('c')]);
    const write = store.begin('delete', ['a', 'b', 'c'])!;
    store.answered(write, result({ done: ['a'], skipped: [{ rowId: 'b', reason: 'file_delete_failed' }, { rowId: 'c', reason: 'not_found' }] }));
    expect(store.records.map((r) => r.rowId)).toEqual(['b']);
  });

  it('comes back as it is by now: a form saved meanwhile is not undone', () => {
    const a = open('a');
    const { store } = page([a]);
    const write = store.begin('not_meal', ['a'])!;
    store.recordSaved({ ...a, occasion: 'Neu' }, 5);
    store.refused(write, null, 'nein');
    expect(store.records[0]).toMatchObject({ occasion: 'Neu', mealType: a.mealType });
  });
});

describe('going back: the person changes their mind before the answers are in', () => {
  it('"Keine Bewirtung" and straight back: the older answer, late, cannot overwrite the newer one', () => {
    const a = open('a');
    const { store } = page([a]);
    const out = store.begin('not_meal', ['a'])!;
    const back = store.begin('restore', ['a'])!;
    expect(store.meals.map((r) => r.rowId)).toEqual(['a']);
    store.answered(back, result({ done: ['a'], records: [restored(a)], at: 20 }));
    store.answered(out, result({ done: ['a'], records: [notMeal(a)], at: 10 }));
    expect(store.dismissed).toEqual([]);
    expect(store.records[0].mealType).toBe('business_meal_external');
  });

  it('answers in order end in the newest change', () => {
    const a = open('a');
    const { store } = page([a]);
    const out = store.begin('not_meal', ['a'])!;
    const back = store.begin('restore', ['a'])!;
    store.answered(out, result({ done: ['a'], records: [notMeal(a)], at: 10 }));
    expect(store.dismissed).toEqual([]);
    store.answered(back, result({ done: ['a'], records: [restored(a)], at: 20 }));
    expect(store.dismissed).toEqual([]);
  });

  it('a late answer does not overwrite a saved form, and a late form save does not undo an answer', () => {
    const a = open('a');
    const { store } = page([a]);
    const write = store.begin('not_meal', ['a'])!;
    store.recordSaved({ ...a, occasion: 'Später' }, 20);
    store.answered(write, result({ done: ['a'], records: [notMeal(a)], at: 10 }));
    expect(store.records[0].occasion).toBe('Später');

    const again = store.begin('not_meal', ['a'])!;
    store.answered(again, result({ done: ['a'], records: [notMeal(a)], at: 30 }));
    store.recordSaved({ ...a, occasion: 'Früher' }, 25);
    expect(store.dismissed.map((r) => r.mealType)).toEqual(['not_a_meal']);
  });

  it('a save arriving after the delete it lost to stays out', () => {
    const a = open('a');
    const { store } = page([a]);
    const write = store.begin('delete', ['a'])!;
    store.answered(write, result({ done: ['a'], at: 20 }));
    store.recordSaved({ ...a, occasion: 'Zu spät' }, 10);
    expect(store.records).toEqual([]);
  });
});

describe('coming back: the page left while the answer is out', () => {
  it('a new store starts with the write, so no second click is offered', () => {
    const a = open('a');
    const { app, store, close } = page([a]);
    store.begin('not_meal', ['a']);
    close();
    const next = new MealsStore(seed([a]), app.mealOutbox);
    app.openMeals(next);
    expect(next.dismissed.map((r) => r.rowId)).toEqual(['a']);
    expect(next.begin('not_meal', ['a'])).toBeNull();
  });

  it('a write begun on the last visit ends on the store open now', () => {
    const a = open('a');
    const { app, store, close } = page([a]);
    const write = store.begin('not_meal', ['a'])!;
    close();
    const next = new MealsStore(seed([a]), app.mealOutbox);
    app.openMeals(next);
    store.answered(write, result({ done: ['a'], records: [{ ...notMeal(a), place: 'bestätigt' }] }));
    expect(next.dismissed[0].place).toBe('bestätigt');
  });

  it('a refusal with no page open reaches the shell, naming the receipt, and rolls the new visit back', () => {
    const a = open('a');
    const { app, store, close } = page([a]);
    const write = store.begin('delete', ['a'])!;
    close();
    store.refused(write, 'Lokal A', 'Dafür fehlt die Berechtigung.');
    expect(app.looseRefusals).toMatchObject([{ who: 'Lokal A', message: 'Dafür fehlt die Berechtigung.' }]);
    const next = new MealsStore(seed([a]), app.mealOutbox);
    app.openMeals(next);
    expect(next.records.map((r) => r.rowId)).toEqual(['a']);
    // Back on the page the row itself shows what it is about.
    expect(app.looseRefusals).toMatchObject([{ who: null }]);
  });

  it('a read from before the answer is corrected by it; a read from after it is believed', () => {
    const a = open('a');
    const { app, store, close } = page([a]);
    const write = store.begin('not_meal', ['a'])!;
    store.answered(write, result({ done: ['a'], records: [notMeal(a)], at: 10 }));
    close();
    // The back button serves what the router kept, from before the answer.
    expect(new MealsStore(seed([a], 5), app.mealOutbox).dismissed.map((r) => r.rowId)).toEqual(['a']);
    // Another tab took it back later: that read knows better.
    expect(new MealsStore(seed([restored(a)], 15), app.mealOutbox).dismissed).toEqual([]);
  });

  it('a seed read while a delete was out does not bring the receipt back after its answer', () => {
    const a = open('a');
    const outbox = new MealsOutbox();
    const first = new MealsStore(seed([a]), outbox);
    const write = first.begin('delete', ['a'])!;
    const second = new MealsStore(seed([a], 5), outbox);
    first.answered(write, result({ done: ['a'], at: 10 }));
    second.catchUp();
    expect(second.records).toEqual([]);
  });
});

describe('after a refusal, acting again', () => {
  it('takes the refusal away, and the new answer counts', () => {
    const a = open('a');
    const { app, store } = page([a]);
    const refused = store.begin('not_meal', ['a'])!;
    store.refused(refused, null, 'nein');
    const again = store.begin('not_meal', ['a'])!;
    expect(app.looseRefusals).toEqual([]);
    store.answered(again, result({ done: ['a'], records: [notMeal(a)], at: 30 }));
    expect(store.dismissed.map((r) => r.rowId)).toEqual(['a']);
  });

  it('closing a refusal takes it away, and only that one', () => {
    const { app, store } = page([open('a'), open('b')]);
    store.refused(store.begin('not_meal', ['a'])!, null, 'eins');
    store.refused(store.begin('not_meal', ['b'])!, null, 'zwei');
    app.closeRefusal(app.looseRefusals[0].key);
    expect(app.looseRefusals.map((r) => r.message)).toEqual(['zwei']);
  });

  it('a company switch takes everything along: a new app store knows nothing of the last', () => {
    const { store, app } = page([open('a')]);
    store.refused(store.begin('not_meal', ['a'])!, null, 'nein');
    expect(app.looseRefusals).toHaveLength(1);
    expect(new AppStore().looseRefusals).toEqual([]);
  });
});
