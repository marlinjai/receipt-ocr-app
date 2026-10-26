import type { SelectOption } from '@marlinjai/data-table-core';

const MAX_COLUMNS_PER_CALL = 200;

/**
 * Select options asked for column by column, fetched together (plan
 * docs/plans/2026-10-26-fast-dashboard-and-spending.md, decision 5). The table
 * asks for each select column on its own, all in the same moment; the asks of
 * one moment become one call of `load`, and each caller gets its own column's
 * options. Nothing is kept: a later ask makes a new call, so an option added
 * in between is always there. A failed call fails every ask it carried.
 */
export function batchedSelectOptions(load: (columnIds: string[]) => Promise<Record<string, SelectOption[]>>): (columnId: string) => Promise<SelectOption[]> {
  // The action rejects more than MAX_COLUMNS_PER_CALL ids, so a larger moment is split and merged.
  const loadInChunks = async (columnIds: string[]) => {
    const chunks: string[][] = [];
    for (let i = 0; i < columnIds.length; i += MAX_COLUMNS_PER_CALL) chunks.push(columnIds.slice(i, i + MAX_COLUMNS_PER_CALL));
    return Object.assign({}, ...(await Promise.all(chunks.map((chunk) => load(chunk))))) as Record<string, SelectOption[]>;
  };
  let pending: { columnIds: Set<string>; result: Promise<Record<string, SelectOption[]>> } | null = null;
  return (columnId) => {
    if (!pending) {
      const columnIds = new Set<string>();
      // Started after the current moment's asks are in: they all ride on this one call.
      const result = Promise.resolve().then(() => {
        pending = null;
        return loadInChunks([...columnIds]);
      });
      pending = { columnIds, result };
    }
    pending.columnIds.add(columnId);
    return pending.result.then((byColumn) => byColumn[columnId] ?? []);
  };
}
