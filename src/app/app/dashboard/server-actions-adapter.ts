/**
 * A DatabaseAdapter implementation that delegates every method to server actions.
 * This file is safe to import from client components -- it contains NO Prisma imports.
 */
import type { DatabaseAdapter } from '@marlinjai/data-table-core';
import * as actions from './actions';

export function createServerActionsAdapter(): DatabaseAdapter {
  return {
    // Table operations
    createTable: actions.createTable,
    getTable: actions.getTable,
    updateTable: actions.updateTable,
    deleteTable: actions.deleteTable,
    listTables: actions.listTables,

    // Column operations
    createColumn: actions.createColumn,
    getColumns: actions.getColumns,
    getColumn: actions.getColumn,
    updateColumn: actions.updateColumn,
    deleteColumn: actions.deleteColumn,
    reorderColumns: actions.reorderColumns,

    // Select option operations
    createSelectOption: actions.createSelectOption,
    getSelectOptions: actions.getSelectOptions,
    updateSelectOption: actions.updateSelectOption,
    deleteSelectOption: actions.deleteSelectOption,
    reorderSelectOptions: actions.reorderSelectOptions,

    // Row operations
    createRow: actions.createRow,
    getRow: actions.getRow,
    getRows: actions.getRows,
    updateRow: actions.updateRow,
    deleteRow: actions.deleteRow,
    archiveRow: actions.archiveRow,
    unarchiveRow: actions.unarchiveRow,
    bulkCreateRows: actions.bulkCreateRows,
    bulkDeleteRows: actions.bulkDeleteRows,
    bulkArchiveRows: actions.bulkArchiveRows,

    // Relation operations
    createRelation: actions.createRelation,
    deleteRelation: actions.deleteRelation,
    getRelatedRows: actions.getRelatedRows,
    getRelationsForRow: actions.getRelationsForRow,

    // File reference operations
    addFileReference: actions.addFileReference,
    removeFileReference: actions.removeFileReference,
    getFileReferences: actions.getFileReferences,
    reorderFileReferences: actions.reorderFileReferences,

    // View operations
    createView: actions.createView,
    getViews: actions.getViews,
    getView: actions.getView,
    updateView: actions.updateView,
    deleteView: actions.deleteView,
    reorderViews: actions.reorderViews,

    // Transaction -- not supported via server actions, run sequentially
    async transaction(fn) {
      // Server actions are stateless, so we pass `this` as a fake tx.
      // Each call still goes through its own server action.
      return fn(this as DatabaseAdapter);
    },
  };
}
