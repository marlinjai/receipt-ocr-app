import { describe, expect, it } from 'vitest';
import { GROUP_KIND, GROUP_WRITABLE_COLUMNS, ROW_KIND_COLUMN } from '@/lib/receipts-kind';
import { GROUP_NAME_MAX, GroupError, assertCanJoinGroup, assertCellsWritable, cleanGroupName, sharedValue } from '../rules';
import { columnId, columns } from './fixture';

const code = (run: () => unknown): string => {
  try {
    run();
  } catch (e) {
    if (e instanceof GroupError) return e.code;
    throw e;
  }
  return 'no error';
};

describe('the name of a group', () => {
  it('is trimmed and its inner spaces are folded', () => {
    expect(cleanGroupName('  Messe   Berlin ')).toBe('Messe Berlin');
  });

  it('must not be empty, too long, or something other than text', () => {
    expect(code(() => cleanGroupName('   '))).toBe('invalid_name');
    expect(code(() => cleanGroupName('x'.repeat(GROUP_NAME_MAX + 1)))).toBe('invalid_name');
    expect(code(() => cleanGroupName(null))).toBe('invalid_name');
    expect(cleanGroupName('x'.repeat(GROUP_NAME_MAX))).toHaveLength(GROUP_NAME_MAX);
  });
});

describe('what may go into a group', () => {
  const found = new Map([
    ['r1', { id: 'r1', kind: null }],
    ['g2', { id: 'g2', kind: GROUP_KIND }],
  ]);

  it('receipts of the table', () => {
    expect(code(() => assertCanJoinGroup(['r1'], found))).toBe('no error');
    expect(code(() => assertCanJoinGroup([], found))).toBe('no error');
  });

  it('never a group: groups have one level', () => {
    expect(code(() => assertCanJoinGroup(['r1', 'g2'], found))).toBe('group_in_group');
  });

  it('never a row that is not in the table, and then nothing moves at all', () => {
    expect(code(() => assertCanJoinGroup(['r1', 'elsewhere'], found))).toBe('row_not_found');
  });
});

describe('which cells a row takes', () => {
  it('a receipt takes every cell except its kind', () => {
    expect(code(() => assertCellsWritable(columns, null, { [columnId('Gross')]: 12, [columnId('Date')]: '2026-01-01' }))).toBe('no error');
    expect(code(() => assertCellsWritable(columns, null, { [columnId(ROW_KIND_COLUMN)]: GROUP_KIND }))).toBe('not_writable');
  });

  it('a group takes its name and the columns the views sort by', () => {
    for (const name of GROUP_WRITABLE_COLUMNS) {
      expect(code(() => assertCellsWritable(columns, GROUP_KIND, { [columnId(name)]: 'x' }))).toBe('no error');
    }
  });

  it('a group takes no amount, no date, no share and no kind, so nothing can be summed twice', () => {
    for (const name of ['Gross', 'Net', 'Tax Rate', 'Date', 'FX Rate', 'Business Share %', 'Currency', 'Tip', ROW_KIND_COLUMN]) {
      expect(code(() => assertCellsWritable(columns, GROUP_KIND, { [columnId(name)]: 1 })), name).toBe('not_writable');
    }
  });

  it('one refused cell refuses the whole write', () => {
    expect(code(() => assertCellsWritable(columns, GROUP_KIND, { [columnId('Name')]: 'Messe', [columnId('Gross')]: 5 }))).toBe('not_writable');
  });

  it('a cell of an unknown column is left to the table adapter, which refuses it', () => {
    expect(code(() => assertCellsWritable(columns, GROUP_KIND, { col_unknown: 1 }))).toBe('no error');
  });
});

describe('what a new group takes over from its receipts', () => {
  it('the value they all share', () => {
    expect(sharedValue(['opt_a', 'opt_a'])).toBe('opt_a');
  });

  it('nothing when they differ, when one has none, or when there are none', () => {
    expect(sharedValue(['opt_a', 'opt_b'])).toBeNull();
    expect(sharedValue(['opt_a', null])).toBeNull();
    expect(sharedValue([undefined])).toBeNull();
    expect(sharedValue([])).toBeNull();
  });
});
