---
type: plan
status: in-progress
title: Migrate Receipt Image from url column to the native file column (multi-file rows)
summary: Convert the Receipt Image column to the data-table file type so rows can hold multiple files, retiring the DOM-overlay thumbnail layer, the /thumbnail URL convention, and the hand-rolled upload surfaces.
tags: [data-table, file-column, migration, storage-brain]
date: 2026-08-03
---

# Receipt Image → native `file` column

One file per row is a limitation of the column type, not the platform: the data-table
already ships a multi-file `file` column (dt_files junction with position, per-column
config, FileCell with upload/drop/delete). Receipt Image being a `url` column is WHY
the app grew a fragile DOM-overlay thumbnail layer (crashed 2026-08-02), a PDF
`/thumbnail` URL convention, and five bespoke upload surfaces. Migrating the column
kills that whole layer and gives multi-file rows natively.

## Current facts (verified in code)

- adapter-prisma: `dt_files` model + add/remove/get/reorderFileReference; `getRows`
  merges refs into cells when `query.include` contains `'files'`.
- react: `FileCell` renders chips (mini image thumb or type icon + name), handles
  upload/drop/delete via the provider's `fileAdapter` + `addFileReference` action.
  Gaps: `useRows` never requests `include:['files']`; FileCell uses hardcoded light
  colors and `alert()` for errors.
- App: `DataTableProvider` gets no `fileAdapter` (NoopFileAdapter throws);
  `server-actions-adapter` maps `actions.addFileReference` which does not exist;
  OCR (`actions.ts` processReceipt), Drive attach, detail panel, export, and the
  `/api/files` access guard all speak URL strings; `file-access.ts` already checks
  `dt_files.file_id` FIRST and falls back to JSON/physical-column scans.

## Slices

### 1. data-table react 0.4.2
- `useRows`: always pass `include: ['files']` (adapters without file support ignore it).
- `FileCell`: theme variables instead of hardcoded light colors; inline error state
  instead of `alert()` (blocking dialogs, wrong theme, untestable).
- Publish 0.4.2, bump in app.

### 2. App wiring
- Client `PresignedStorageBrainAdapter` (FileStorageAdapter): `upload` = existing
  presigned flow (`/api/upload/request` → PUT), returns `{id, url:'/api/files/<id>',
  originalName, mimeType, sizeBytes}`; `delete` = ref-only no-op (a Storage Brain
  object may be referenced by several rows; the ref removal IS the delete);
  `getUrl` = `/api/files/<id>`. Passed to `DataTableProvider`.
- Server actions `addFileReference` / `removeFileReference`, guarded like every other
  row mutation (row access via `resolveRowTableIds`; remove resolves ref → row first).
- OCR path: `processReceipt` stops writing a URL cell and adds a file reference
  (OCR metadata into `dt_files.metadata`).
- Drive attach: `addFileReference` instead of `updateRow`; idempotency = "row has ≥1
  ref on the column"; the bare-PDF-URL repair logic and `image-url.ts` become
  obsolete once the data migration has run and are DELETED (helpers, tests, uses).
- Detail panel: renders the ref list (each: preview via lightbox, download name,
  delete-ref button), upload/paste/drop APPENDS (multi-file). Inline preview embeds
  the first file (PDF iframe / image), mime-based — no `/thumbnail` parsing.
- DELETE `ReceiptImagePreview` (DOM overlay) — FileCell renders cells natively.
  `ReceiptLightbox` switches to `{fileUrl, mimeType}` props.
- `file-access.ts`: `dt_files` lookup + fresh-upload window stay; the cells-JSON and
  physical-column LIKE scans are deleted (post-migration nothing references files
  from cells).
- CSV export: serialize `FileReference[]` cells as `; `-joined `originalName`.
- `/api/files/[fileId]/thumbnail` route stays (historical exports link to it).

### 3. Data migration (one-shot, self-healing at boot)
`scripts/migrate-receipt-image-to-file-column.mjs`, invoked by `start.sh` after
`prisma migrate deploy`, idempotent, logged:
1. Find every column named `Receipt Image` with `type='url'`.
2. For each row of its (physical) table: parse `/api/files/<id>(/thumbnail)?` from
   the cell; fetch `originalName/mimeType/sizeBytes` from Storage Brain
   (`GET /api/v1/files/<id>`, server key); insert `dt_files` (skip when
   `rowId+columnId+fileId` exists); clear the cell.
3. Flip the column to `type='file'`, config `{maxFiles: 10, allowedTypes:
   [pdf, png, jpeg], maxSizeBytes: 20MB}`.
Unresolvable cells (dead fileId) are logged and cleared — the file is gone either
way; the log preserves the id. Script is removed in a follow-up PR once prod logs
confirm the run (it no-ops after conversion).

### 4. Tests (incl. revision paths)
- Attach: rows with existing refs are skipped (re-run adds nothing); a row whose ref
  was deleted gets re-attached on re-run (deliberate: re-run restores from Drive).
- Migration URL parser (pure): bare, `/thumbnail`, foreign URLs, blanks.
- CSV serialization of file cells.
- Detail panel logic stays presentational; upload plumbing is the already-tested
  presigned flow.

## Decisions
- Replacing/deleting never deletes Storage Brain objects (shared-ref safety, same
  contract as before).
- `maxFiles: 10` per row (config, adjustable in-place later).
- Export shows names, not URLs (URLs are auth-gated app paths, useless in a sheet).

## Rollout
react 0.4.2 → app PR (wiring + migration script) → deploy → verify live (chips
render, multi-upload in panel, attach idempotent) → follow-up PR deleting the
migration script.
