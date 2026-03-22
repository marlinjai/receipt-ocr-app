-- Data Table Schema for Cloudflare D1
-- Based on @marlinjai/data-table-adapter-d1 with real-columns support

-- Table definitions
CREATE TABLE IF NOT EXISTS dt_tables (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  icon          TEXT,
  migrated      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dt_tables_workspace ON dt_tables(workspace_id);

-- Column definitions
CREATE TABLE IF NOT EXISTS dt_columns (
  id            TEXT PRIMARY KEY,
  table_id      TEXT NOT NULL REFERENCES dt_tables(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  width         INTEGER NOT NULL DEFAULT 200,
  is_primary    INTEGER NOT NULL DEFAULT 0,
  config        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dt_columns_table ON dt_columns(table_id);

-- Select options (for select/multi_select columns)
CREATE TABLE IF NOT EXISTS dt_select_options (
  id            TEXT PRIMARY KEY,
  column_id     TEXT NOT NULL REFERENCES dt_columns(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  color         TEXT,
  position      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_dt_select_options_column ON dt_select_options(column_id);

-- Row metadata (cells stored in real per-table columns, this is the index)
CREATE TABLE IF NOT EXISTS dt_rows (
  id            TEXT PRIMARY KEY,
  table_id      TEXT NOT NULL REFERENCES dt_tables(id) ON DELETE CASCADE,
  cells         TEXT NOT NULL DEFAULT '{}',
  computed      TEXT,
  _title        TEXT,
  _archived     INTEGER NOT NULL DEFAULT 0,
  _created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  _updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dt_rows_table ON dt_rows(table_id);
CREATE INDEX IF NOT EXISTS idx_dt_rows_archived ON dt_rows(table_id, _archived);

-- Multi-select junction table
CREATE TABLE IF NOT EXISTS dt_row_select_values (
  id            TEXT PRIMARY KEY,
  row_id        TEXT NOT NULL,
  column_id     TEXT NOT NULL,
  option_id     TEXT NOT NULL,
  UNIQUE(row_id, column_id, option_id)
);

CREATE INDEX IF NOT EXISTS idx_dt_rsv_row ON dt_row_select_values(row_id, column_id);

-- Relations
CREATE TABLE IF NOT EXISTS dt_relations (
  id              TEXT PRIMARY KEY,
  source_row_id   TEXT NOT NULL,
  source_column_id TEXT NOT NULL,
  target_row_id   TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_row_id, source_column_id, target_row_id)
);

CREATE INDEX IF NOT EXISTS idx_dt_relations_source ON dt_relations(source_row_id, source_column_id);
CREATE INDEX IF NOT EXISTS idx_dt_relations_target ON dt_relations(target_row_id);

-- File references
CREATE TABLE IF NOT EXISTS dt_files (
  id            TEXT PRIMARY KEY,
  row_id        TEXT NOT NULL,
  column_id     TEXT NOT NULL,
  file_id       TEXT NOT NULL,
  file_url      TEXT NOT NULL,
  original_name TEXT NOT NULL,
  file_type     TEXT NOT NULL,
  size_bytes    INTEGER,
  position      INTEGER NOT NULL DEFAULT 0,
  metadata      TEXT
);

CREATE INDEX IF NOT EXISTS idx_dt_files_row_column ON dt_files(row_id, column_id);

-- Views
CREATE TABLE IF NOT EXISTS dt_views (
  id            TEXT PRIMARY KEY,
  table_id      TEXT NOT NULL REFERENCES dt_tables(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'table',
  is_default    INTEGER NOT NULL DEFAULT 0,
  position      INTEGER NOT NULL DEFAULT 0,
  config        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dt_views_table ON dt_views(table_id);
