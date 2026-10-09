import { describe, expect, it } from 'vitest';
import { duplicatedColumnNames, firstColumnByName, firstColumnIdByName } from '../column-lookup';
import { rowToMealRecord } from '../meals/record';
import { buildCells } from '../sheet-import/build-cells';

const columns = [
  { id: 'name', name: 'Name', type: 'text' },
  { id: 'occasion-first', name: 'Occasion', type: 'text' },
  { id: 'place-first', name: 'Place', type: 'text' },
  { id: 'occasion-second', name: 'Occasion', type: 'text' },
  { id: 'place-second', name: 'Place', type: 'text' },
];

describe('resolving a column by name', () => {
  it('of two columns with one name, the first in the list answers', () => {
    expect(firstColumnIdByName(columns).get('Occasion')).toBe('occasion-first');
    expect(firstColumnByName(columns).get('Place')?.id).toBe('place-first');
    // The rule every `columns.find((c) => c.name === name)` in the app already follows.
    expect(columns.find((c) => c.name === 'Occasion')?.id).toBe(firstColumnIdByName(columns).get('Occasion'));
  });

  it('names the columns that exist more than once', () => {
    expect(duplicatedColumnNames(columns)).toEqual(['Occasion', 'Place']);
    expect(duplicatedColumnNames(columns.slice(0, 3))).toEqual([]);
  });
});

describe('a table that holds a column twice', () => {
  it('the meal reader takes the value from the column the save writes to', () => {
    // The save resolves "Occasion" with `find`, so it writes the first column.
    const written = { 'occasion-first': 'Abstimmung Relaunch Webshop', 'place-first': 'Testlokal, Musterstadt' };
    const record = rowToMealRecord({ id: 'row-1', cells: written }, columns, new Map(), []);
    expect(record.occasion).toBe('Abstimmung Relaunch Webshop');
    expect(record.place).toBe('Testlokal, Musterstadt');
  });

  it('the sheet importer puts the exchange rate into the column every reader takes', () => {
    const twice = [
      { id: 'name', name: 'Name', type: 'text' },
      { id: 'fx-first', name: 'FX Rate', type: 'number' },
      { id: 'fx-second', name: 'FX Rate', type: 'number' },
    ];
    const cells = buildCells({ Name: 'Beleg' }, twice, {}, { fxRate: 1.0834 });
    expect(cells['fx-first']).toBe(1.0834);
    expect(cells['fx-second']).toBeUndefined();
  });
});
