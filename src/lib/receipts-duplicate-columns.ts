import 'server-only';
import type { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import type { CellValue, Column, Row } from '@marlinjai/data-table-core';

/**
 * Folding a column that exists twice back into one.
 *
 * Two page loads that both found a column missing each created it (see the
 * lock in `ensureReceiptsTable`, which now prevents that). The table then held
 * two "Occasion" columns: saves went into one, reads came from the other, and
 * a saved value looked lost although it was stored.
 *
 * For each name the oldest column is kept. Every value the other column holds
 * is moved over where the kept one is empty, and only a column whose values
 * are all accounted for is removed. A column holding a value that differs from
 * the kept one's is never deleted: it is renamed, so no reader takes it for
 * the real one and nothing a person typed is thrown away.
 */

export interface DuplicateColumnOutcome {
  name: string;
  keptColumnId: string;
  strayColumnId: string;
  /** Rows whose value was moved from the stray column into the kept one. */
  moved: number;
  /** Rows where both columns hold a value and the two differ. */
  conflicts: number;
  /** 'removed' when every value is accounted for, otherwise the name the stray column now carries. */
  result: 'removed' | { renamedTo: string };
}

/** Types whose values sit in the row itself and can be compared and copied cell by cell. */
const CELL_TYPES = new Set(['text', 'number', 'date', 'boolean', 'url', 'select']);
/** Types that hold no stored value: they are worked out from other columns. */
const COMPUTED_TYPES = new Set(['formula', 'rollup']);

const PAGE = 500;

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function comparable(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return String(value);
  return String(value).trim();
}

/** Oldest first: the column that existed before the second one was created by mistake. */
function byAge(a: Column, b: Column): number {
  if (a.position !== b.position) return a.position - b.position;
  const created = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  if (created !== 0) return created;
  return a.id < b.id ? -1 : 1;
}

async function everyRow(adapter: PrismaAdapter, tableId: string): Promise<Row[]> {
  const out: Row[] = [];
  let offset = 0;
  for (;;) {
    // Archived rows count: a value on one of them is still a value someone entered.
    const page = await adapter.getRows(tableId, { limit: PAGE, offset, includeArchived: true });
    out.push(...page.items);
    if (!page.hasMore || page.items.length === 0) break;
    offset += page.items.length;
  }
  return out;
}

function unusedName(base: string, taken: Set<string>): string {
  for (let n = 2; ; n++) {
    const candidate = `${base} (duplicate ${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Merge every column of `tableId` whose name is in `names` and exists more
 * than once. Names outside `names` are left alone: a person may give two of
 * their own columns the same name, and nothing in the app resolves those.
 */
export async function mergeDuplicateColumns(
  adapter: PrismaAdapter,
  tableId: string,
  names: readonly string[],
): Promise<DuplicateColumnOutcome[]> {
  const columns = await adapter.getColumns(tableId);
  const wanted = new Set(names);
  const groups = new Map<string, Column[]>();
  for (const column of columns) {
    if (!wanted.has(column.name)) continue;
    groups.set(column.name, [...(groups.get(column.name) ?? []), column]);
  }
  const duplicated = [...groups.values()].filter((group) => group.length > 1);
  if (duplicated.length === 0) return [];

  const taken = new Set(columns.map((c) => c.name));
  const rows = await everyRow(adapter, tableId);
  // What the kept columns hold, kept current as values are moved in, so a
  // third column with the same name is compared against the merged state.
  const keptValues = new Map<string, Map<string, unknown>>();
  const outcomes: DuplicateColumnOutcome[] = [];
  // Columns are removed or renamed only after every value has been moved:
  // dropping a column changes the shape of the row table, and the adapter's
  // own row reads must not run into that halfway through the merge.
  const settle: Array<() => Promise<void>> = [];

  for (const group of duplicated) {
    const [kept, ...strays] = [...group].sort(byAge);
    const values = new Map<string, unknown>(rows.map((row) => [row.id, row.cells[kept.id]]));
    keptValues.set(kept.id, values);

    for (const stray of strays) {
      const outcome: DuplicateColumnOutcome = {
        name: kept.name,
        keptColumnId: kept.id,
        strayColumnId: stray.id,
        moved: 0,
        conflicts: 0,
        result: 'removed',
      };

      if (COMPUTED_TYPES.has(stray.type) && stray.type === kept.type) {
        // Nothing is stored in a computed column, so there is nothing to lose.
        settle.push(() => adapter.deleteColumn(stray.id));
        outcomes.push(outcome);
        continue;
      }

      const mergeable = stray.type === kept.type && CELL_TYPES.has(stray.type);
      if (mergeable) {
        // A select cell holds the id of an option of ITS column: translate by option name.
        let translate = (value: unknown): unknown => value;
        if (stray.type === 'select') {
          const [strayOptions, keptOptions] = await Promise.all([
            adapter.getSelectOptions(stray.id),
            adapter.getSelectOptions(kept.id),
          ]);
          const nameById = new Map(strayOptions.map((o) => [o.id, o.name]));
          const keptIdByName = new Map(keptOptions.map((o) => [o.name, o.id]));
          translate = (value) => keptIdByName.get(nameById.get(String(value)) ?? '') ?? null;
        }

        for (const row of rows) {
          const strayValue = row.cells[stray.id];
          if (isEmpty(strayValue)) continue;
          const moved = translate(strayValue);
          const keptValue = values.get(row.id);
          if (isEmpty(moved)) {
            // An option the kept column does not have: the value cannot be carried over.
            outcome.conflicts++;
          } else if (isEmpty(keptValue)) {
            await adapter.updateRow(row.id, { [kept.id]: moved as CellValue });
            values.set(row.id, moved);
            outcome.moved++;
          } else if (comparable(keptValue) !== comparable(moved)) {
            outcome.conflicts++;
          }
        }
      }

      // Files, relations, multi-selects, or two columns of different types
      // under one name are not merged cell by cell, so they are never deleted.
      if (mergeable && outcome.conflicts === 0) {
        settle.push(() => adapter.deleteColumn(stray.id));
      } else {
        const renamedTo = unusedName(kept.name, taken);
        taken.add(renamedTo);
        settle.push(async () => {
          await adapter.updateColumn(stray.id, { name: renamedTo });
        });
        outcome.result = { renamedTo };
      }
      outcomes.push(outcome);
    }
  }

  for (const step of settle) await step();
  return outcomes;
}
