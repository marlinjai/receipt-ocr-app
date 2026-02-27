import { BaseDatabaseAdapter } from '@marlinjai/data-table-core';
import type {
  Table, Column, Row, View, SelectOption, FileReference,
  CreateTableInput, UpdateTableInput,
  CreateColumnInput, UpdateColumnInput,
  CreateRowInput, QueryOptions, QueryResult,
  CreateViewInput, UpdateViewInput,
  CreateSelectOptionInput, UpdateSelectOptionInput,
  CreateRelationInput, CreateFileRefInput,
  CellValue, DatabaseAdapter,
} from '@marlinjai/data-table-core';
import { DataBrain } from '@marlinjai/data-brain-sdk';

export interface DataBrainAdapterConfig {
  baseUrl: string;
  apiKey: string;
  workspaceId?: string;
}

/**
 * DatabaseAdapter backed by the Data Brain HTTP API.
 * Persists data regardless of runtime environment (local dev, Cloudflare, etc.).
 */
export class DataBrainAdapter extends BaseDatabaseAdapter {
  private readonly client: DataBrain;
  private readonly workspaceId?: string;

  constructor(config: DataBrainAdapterConfig) {
    super();
    this.client = new DataBrain({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });
    this.workspaceId = config.workspaceId;
  }

  // Tables
  async createTable(input: CreateTableInput): Promise<Table> {
    return this.client.createTable(input);
  }
  async getTable(tableId: string): Promise<Table | null> {
    return this.client.getTable(tableId);
  }
  async updateTable(tableId: string, updates: UpdateTableInput): Promise<Table> {
    return this.client.updateTable(tableId, updates);
  }
  async deleteTable(tableId: string): Promise<void> {
    return this.client.deleteTable(tableId);
  }
  async listTables(workspaceId: string): Promise<Table[]> {
    return this.client.listTables(workspaceId);
  }

  // Columns
  async createColumn(input: CreateColumnInput): Promise<Column> {
    return this.client.createColumn(input);
  }
  async getColumns(tableId: string): Promise<Column[]> {
    return this.client.getColumns(tableId);
  }
  async getColumn(columnId: string): Promise<Column | null> {
    return this.client.getColumn(columnId);
  }
  async updateColumn(columnId: string, updates: UpdateColumnInput): Promise<Column> {
    return this.client.updateColumn(columnId, updates);
  }
  async deleteColumn(columnId: string): Promise<void> {
    return this.client.deleteColumn(columnId);
  }
  async reorderColumns(tableId: string, columnIds: string[]): Promise<void> {
    return this.client.reorderColumns(tableId, columnIds);
  }

  // Select Options
  async createSelectOption(input: CreateSelectOptionInput): Promise<SelectOption> {
    return this.client.createSelectOption(input);
  }
  async getSelectOptions(columnId: string): Promise<SelectOption[]> {
    return this.client.getSelectOptions(columnId);
  }
  async updateSelectOption(optionId: string, updates: UpdateSelectOptionInput): Promise<SelectOption> {
    return this.client.updateSelectOption(optionId, updates);
  }
  async deleteSelectOption(optionId: string): Promise<void> {
    return this.client.deleteSelectOption(optionId);
  }
  async reorderSelectOptions(columnId: string, optionIds: string[]): Promise<void> {
    return this.client.reorderSelectOptions(columnId, optionIds);
  }

  // Rows
  async createRow(input: CreateRowInput): Promise<Row> {
    return this.client.createRow(input);
  }
  async getRow(rowId: string): Promise<Row | null> {
    return this.client.getRow(rowId);
  }
  async getRows(tableId: string, query?: QueryOptions): Promise<QueryResult<Row>> {
    return this.client.getRows(tableId, query);
  }
  async updateRow(rowId: string, cells: Record<string, CellValue>): Promise<Row> {
    return this.client.updateRow(rowId, cells);
  }
  async deleteRow(rowId: string): Promise<void> {
    return this.client.deleteRow(rowId);
  }
  async archiveRow(rowId: string): Promise<void> {
    return this.client.archiveRow(rowId);
  }
  async unarchiveRow(rowId: string): Promise<void> {
    return this.client.unarchiveRow(rowId);
  }
  async bulkCreateRows(inputs: CreateRowInput[]): Promise<Row[]> {
    return this.client.bulkCreateRows(inputs);
  }
  async bulkDeleteRows(rowIds: string[]): Promise<void> {
    return this.client.bulkDeleteRows(rowIds);
  }
  async bulkArchiveRows(rowIds: string[]): Promise<void> {
    return this.client.bulkArchiveRows(rowIds);
  }

  // Relations
  async createRelation(input: CreateRelationInput): Promise<void> {
    return this.client.createRelation(input);
  }
  async deleteRelation(sourceRowId: string, columnId: string, targetRowId: string): Promise<void> {
    return this.client.deleteRelation(sourceRowId, columnId, targetRowId);
  }
  async getRelatedRows(rowId: string, columnId: string): Promise<Row[]> {
    return this.client.getRelatedRows(rowId, columnId);
  }
  async getRelationsForRow(rowId: string): Promise<Array<{ columnId: string; targetRowId: string }>> {
    return this.client.getRelationsForRow(rowId);
  }

  // File References
  async addFileReference(input: CreateFileRefInput): Promise<FileReference> {
    return this.client.addFileReference(input);
  }
  async removeFileReference(fileRefId: string): Promise<void> {
    return this.client.removeFileReference(fileRefId);
  }
  async getFileReferences(rowId: string, columnId: string): Promise<FileReference[]> {
    return this.client.getFileReferences(rowId, columnId);
  }
  async reorderFileReferences(rowId: string, columnId: string, fileRefIds: string[]): Promise<void> {
    return this.client.reorderFileReferences(rowId, columnId, fileRefIds);
  }

  // Views
  async createView(input: CreateViewInput): Promise<View> {
    return this.client.createView(input);
  }
  async getViews(tableId: string): Promise<View[]> {
    return this.client.getViews(tableId);
  }
  async getView(viewId: string): Promise<View | null> {
    return this.client.getView(viewId);
  }
  async updateView(viewId: string, updates: UpdateViewInput): Promise<View> {
    return this.client.updateView(viewId, updates);
  }
  async deleteView(viewId: string): Promise<void> {
    return this.client.deleteView(viewId);
  }
  async reorderViews(tableId: string, viewIds: string[]): Promise<void> {
    return this.client.reorderViews(tableId, viewIds);
  }

  // Transactions - HTTP cannot provide real ACID transactions; execute sequentially
  async transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    return fn(this);
  }
}
