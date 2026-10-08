import { describe, expect, it } from 'vitest';
import { MEAL_BATCH_MAX, batchOutcomeNotice, normalizeRowIds, type MealBatchResult } from '../batch';

function result(overrides: Partial<MealBatchResult> = {}): MealBatchResult {
  return { done: [], records: [], skipped: [], ...overrides };
}

describe('normalizeRowIds', () => {
  it('keeps strings, trims, drops blanks and repeats', () => {
    expect(normalizeRowIds(['a', ' b ', 'a', '', '  '])).toEqual(['a', 'b']);
  });

  it('refuses anything that is not a usable list', () => {
    expect(normalizeRowIds(undefined)).toBeNull();
    expect(normalizeRowIds('a')).toBeNull();
    expect(normalizeRowIds({ length: 1, 0: 'a' })).toBeNull();
    expect(normalizeRowIds([])).toBeNull();
    expect(normalizeRowIds([1, null, {}])).toBeNull();
  });

  it('refuses a batch above the limit', () => {
    const ids = Array.from({ length: MEAL_BATCH_MAX + 1 }, (_, i) => `row-${i}`);
    expect(normalizeRowIds(ids)).toBeNull();
    expect(normalizeRowIds(ids.slice(1))).toHaveLength(MEAL_BATCH_MAX);
  });
});

describe('batchOutcomeNotice', () => {
  it('delete: names the count', () => {
    expect(batchOutcomeNotice('delete', result({ done: ['a', 'b', 'c'] }))).toEqual({ tone: 'ok', text: '3 Belege gelöscht.' });
    expect(batchOutcomeNotice('delete', result({ done: ['a'] }), 'Testlokal').text).toBe('„Testlokal“ gelöscht.');
  });

  it('"Keine Bewirtung": says where the receipts are found and that they can be taken back', () => {
    const many = batchOutcomeNotice('not_meal', result({ done: ['a', 'b'] }));
    expect(many.tone).toBe('ok');
    expect(many.text).toContain('2 Belege werden nicht mehr als Bewirtung geführt.');
    expect(many.text).toContain('unter „Keine Bewirtung“');
    expect(many.text).toContain('wieder aufnehmen');
    const one = batchOutcomeNotice('not_meal', result({ done: ['a'] }), 'Testlokal');
    expect(one.text).toContain('„Testlokal“ wird nicht mehr als Bewirtung geführt.');
    expect(one.text).toContain('lässt er sich');
  });

  it('partial: reports the rest as done and names what was skipped as gone', () => {
    const notice = batchOutcomeNotice(
      'delete',
      result({ done: ['a', 'b'], skipped: [{ rowId: 'c', reason: 'not_found' }] }),
    );
    expect(notice.tone).toBe('warn');
    expect(notice.text).toContain('2 Belege gelöscht.');
    expect(notice.text).toContain('1 Beleg übersprungen: nicht mehr vorhanden');
  });

  it('a stored file that could not be deleted is an error and says the receipt was kept', () => {
    const notice = batchOutcomeNotice(
      'delete',
      result({ done: ['a'], skipped: [{ rowId: 'b', reason: 'file_delete_failed' }] }),
    );
    expect(notice.tone).toBe('danger');
    expect(notice.text).toContain('Bei 1 Beleg ließ sich die gespeicherte Datei nicht löschen.');
    expect(notice.text).toContain('nicht gelöscht');
    expect(notice.text).not.toContain('ausgewählt');
  });

  it('says the kept receipts stay selected only where the view has a selection', () => {
    const notice = batchOutcomeNotice(
      'delete',
      result({ skipped: [{ rowId: 'b', reason: 'file_delete_failed' }] }),
      undefined,
      true,
    );
    expect(notice.text).toContain('bleibt ausgewählt');
  });

  it('nothing done at all is said plainly', () => {
    const notice = batchOutcomeNotice('delete', result({ skipped: [{ rowId: 'a', reason: 'failed' }] }));
    expect(notice.tone).toBe('danger');
    expect(notice.text).toContain('Es wurde kein Beleg gelöscht.');
    expect(notice.text).toContain('Bei 1 Beleg ist ein Fehler aufgetreten');
  });

  it('take back: names the count', () => {
    expect(batchOutcomeNotice('restore', result({ done: ['a'] }), 'Testlokal').text).toBe(
      '„Testlokal“ wird wieder als Bewirtung geführt, mit den zuvor erfassten Angaben.',
    );
  });
});
