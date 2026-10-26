import type { SelectOption } from '@marlinjai/data-table-core';

/**
 * Select options asked for column by column, fetched together (plan
 * docs/plans/2026-10-26-fast-dashboard-and-spending.md, decision 5). The table
 * asks for each select column on its own, all in the same moment; the asks of
 * one moment become one call of `load`, and each caller gets its own column's
 * options. Nothing is kept: a later ask makes a new call, so an option added
 * in between is always there. A failed call fails every ask it carried.
 */
export function batchedSelectOptions(load: (columnIds: string[]) => Promise<Record<string, SelectOption[]>>): (columnId: string) => Promise<SelectOption[]> {
  let pending: { columnIds: Set<string>; result: Promise<Record<string, SelectOption[]>> } | null = null;
  return (columnId) => {
    if (!pending) {
      const columnIds = new Set<string>();
      // Started after the current moment's asks are in: they all ride on this one call.
      const result = Promise.resolve().then(() => {
        pending = null;
        return load([...columnIds]);
      });
      pending = { columnIds, result };
    }
    pending.columnIds.add(columnId);
    return pending.result.then((byColumn) => byColumn[columnId] ?? []);
  };
}
