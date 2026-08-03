'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { Row, Column, SelectOption } from '@marlinjai/data-table-core';
import { uploadReceiptFile, validateReceiptFile } from '@/lib/receipt-file-upload';
import ReceiptLightbox, { lightboxTarget } from './ReceiptLightbox';

interface ReceiptDetailPanelProps {
  row: Row;
  columns: Column[];
  selectOptions: Map<string, SelectOption[]>;
  onClose: () => void;
  /** Set the row's Receipt Image cell (upload-into-row / replace-file). */
  onSetReceiptImage?: (rowId: string, url: string) => Promise<void>;
}


function getCellDisplay(
  col: Column,
  value: unknown,
  selectOptions: Map<string, SelectOption[]>,
): string {
  if (value === null || value === undefined || value === '') return '—';

  switch (col.type) {
    case 'number':
      if (col.name === 'Confidence') return `${value}%`;
      if (col.name === 'Tax Rate') return `${value}%`;
      if (col.name === 'Gross' || col.name === 'Net')
        return `€${Number(value).toFixed(2)}`;
      return String(value);

    case 'date': {
      const d = new Date(String(value));
      if (isNaN(d.getTime())) return String(value);
      return d.toLocaleDateString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });
    }

    case 'select': {
      const opts = selectOptions.get(col.id) ?? [];
      const opt = opts.find((o) => o.id === value);
      return opt?.name ?? String(value);
    }

    default:
      return String(value);
  }
}

function getSelectColor(
  col: Column,
  value: unknown,
  selectOptions: Map<string, SelectOption[]>,
): string | null {
  if (col.type !== 'select') return null;
  const opts = selectOptions.get(col.id) ?? [];
  const opt = opts.find((o) => o.id === value);
  return opt?.color ?? null;
}

export default function ReceiptDetailPanel({
  row,
  columns,
  selectOptions,
  onClose,
  onSetReceiptImage,
}: ReceiptDetailPanelProps) {
  const [ocrExpanded, setOcrExpanded] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Upload a file straight into THIS row's Receipt Image (no new row, no OCR
  // run). Replacing only re-points the cell; the previous Storage Brain object
  // is kept because nothing guarantees it isn't referenced by another row.
  const handleFilePicked = useCallback(
    async (file: File) => {
      if (!onSetReceiptImage) return;
      const rejection = validateReceiptFile(file);
      if (rejection) {
        setUploadError(rejection);
        return;
      }
      setUploadBusy(true);
      setUploadError(null);
      try {
        await onSetReceiptImage(row.id, await uploadReceiptFile(file));
      } catch (e) {
        setUploadError(e instanceof Error ? e.message : 'Upload failed');
      } finally {
        setUploadBusy(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [onSetReceiptImage, row.id],
  );

  // Cmd/Ctrl+V a file anywhere while the panel is open (unless typing in a
  // field) uploads it into this row.
  useEffect(() => {
    if (!onSetReceiptImage) return;
    const onPaste = (e: ClipboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      const file = e.clipboardData?.files?.[0];
      if (!file) return;
      e.preventDefault();
      void handleFilePicked(file);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [onSetReceiptImage, handleFilePicked]);

  const getCol = (name: string) => columns.find((c) => c.name === name);
  const getVal = (name: string) => {
    const col = getCol(name);
    return col ? row.cells[col.id] : undefined;
  };

  const name = getVal('Name');
  const vendor = getVal('Vendor');
  const gross = getVal('Gross');
  const net = getVal('Net');
  const taxRate = getVal('Tax Rate');
  const date = getVal('Date');
  const category = getVal('Category');
  const konto = getVal('Konto');
  const status = getVal('Status');
  const confidence = getVal('Confidence');
  const receiptImage = getVal('Receipt Image');
  const ocrText = getVal('OCR Text');
  const zuordnung = getVal('Zuordnung');

  const categoryCol = getCol('Category');
  const statusCol = getCol('Status');
  const zuordnungCol = getCol('Zuordnung');

  const fields: Array<{
    label: string;
    value: string;
    color?: string | null;
    fullWidth?: boolean;
  }> = [
    {
      label: 'Vendor',
      value: vendor ? String(vendor) : '—',
    },
    {
      label: 'Gross',
      value: gross != null ? `€${Number(gross).toFixed(2)}` : '—',
    },
    {
      label: 'Net',
      value: net != null ? `€${Number(net).toFixed(2)}` : '—',
    },
    {
      label: 'Tax Rate',
      value: taxRate != null ? `${taxRate}%` : '—',
    },
    {
      label: 'Date',
      value: date
        ? (() => {
            const d = new Date(String(date));
            return isNaN(d.getTime())
              ? String(date)
              : d.toLocaleDateString('de-DE', {
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                });
          })()
        : '—',
    },
    {
      label: 'Category',
      value: categoryCol
        ? getCellDisplay(categoryCol, category, selectOptions)
        : '—',
      color: categoryCol
        ? getSelectColor(categoryCol, category, selectOptions)
        : null,
    },
    {
      label: 'Konto (SKR03)',
      value: konto ? String(konto) : '—',
    },
    {
      label: 'Zuordnung',
      value: zuordnungCol
        ? getCellDisplay(zuordnungCol, zuordnung, selectOptions)
        : '—',
      color: zuordnungCol
        ? getSelectColor(zuordnungCol, zuordnung, selectOptions)
        : null,
    },
    {
      label: 'Status',
      value: statusCol
        ? getCellDisplay(statusCol, status, selectOptions)
        : '—',
      color: statusCol
        ? getSelectColor(statusCol, status, selectOptions)
        : null,
    },
    {
      label: 'Confidence',
      value: confidence != null ? `${confidence}%` : '—',
    },
  ];

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel — the whole surface is a drop target for the receipt file */}
      <div
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-gray-800 bg-gray-950 shadow-2xl"
        onDragOver={(e) => {
          if (!onSetReceiptImage || !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDragActive(false);
        }}
        onDrop={(e) => {
          if (!onSetReceiptImage) return;
          e.preventDefault();
          setDragActive(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void handleFilePicked(file);
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-gray-800 px-6 py-5">
          <div className="min-w-0 flex-1 pr-4">
            <h2 className="text-lg font-semibold text-gray-100 leading-tight">
              {name ? String(name) : 'Receipt'}
            </h2>
            {vendor && (
              <p className="mt-1 text-sm text-gray-500">{String(vendor)}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-300"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Receipt image (view + upload-into-row / replace) */}
          <div className={`rounded-xl border bg-gray-900 p-4 ${dragActive ? 'border-blue-500 ring-1 ring-blue-500/40' : 'border-gray-800'}`}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500">
                Receipt Image
              </h3>
              {onSetReceiptImage && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadBusy}
                  className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {uploadBusy ? 'Uploading…' : receiptImage ? 'Replace file' : 'Upload file'}
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFilePicked(file);
              }}
            />
            {receiptImage && String(receiptImage) ? (
              // Inline preview of the ACTUAL file: PDFs render in an embedded
              // viewer, images full-width. The expand button (and, for images,
              // clicking the preview) opens the fullscreen lightbox — an iframe
              // swallows clicks, so PDFs need the explicit button.
              (() => {
                const { fullUrl, isPdf } = lightboxTarget(String(receiptImage));
                return (
                  <div className="relative">
                    {isPdf ? (
                      <iframe
                        src={`${fullUrl}#toolbar=0&navpanes=0`}
                        title="Receipt preview"
                        className="h-[420px] w-full rounded-lg border-0 bg-[#1e1e2e]"
                      />
                    ) : (
                      <button
                        onClick={() => setLightboxOpen(true)}
                        className="flex w-full cursor-zoom-in justify-center rounded-lg transition-opacity hover:opacity-80"
                        aria-label="Open full-size preview"
                      >
                        <img src={fullUrl} alt="Receipt" className="max-h-[420px] rounded-lg object-contain" />
                      </button>
                    )}
                    <button
                      onClick={() => setLightboxOpen(true)}
                      className="absolute right-2 top-2 rounded-md border border-gray-700 bg-black/60 px-2 py-1 text-xs text-gray-300 hover:bg-black/80 hover:text-white"
                      aria-label="Open full-size preview"
                    >
                      ⤢ Expand
                    </button>
                  </div>
                );
              })()
            ) : (
              <p className="text-xs text-gray-500">
                No file attached yet. Upload, paste (Cmd+V), or drop a PDF, PNG, or JPEG here.
              </p>
            )}
            {uploadError && <p className="mt-2 text-xs text-red-400">{uploadError}</p>}
          </div>

          {lightboxOpen && receiptImage && String(receiptImage) && (
            <ReceiptLightbox url={String(receiptImage)} onClose={() => setLightboxOpen(false)} />
          )}

          {/* Fields grid */}
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
            <h3 className="mb-4 text-xs font-medium uppercase tracking-wider text-gray-500">
              Details
            </h3>
            <div className="grid grid-cols-2 gap-x-6 gap-y-4">
              {fields.map((field) => (
                <div key={field.label}>
                  <dt className="text-xs text-gray-500">{field.label}</dt>
                  <dd className="mt-0.5 text-sm text-gray-200">
                    {field.color ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: field.color }}
                        />
                        {field.value}
                      </span>
                    ) : (
                      field.value
                    )}
                  </dd>
                </div>
              ))}
            </div>
          </div>

          {/* OCR Text */}
          {ocrText && String(ocrText) && (
            <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500">
                  OCR Text
                </h3>
                <button
                  onClick={() => setOcrExpanded(!ocrExpanded)}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  {ocrExpanded ? 'Collapse' : 'Expand'}
                </button>
              </div>
              <pre
                className={`mt-3 whitespace-pre-wrap text-xs text-gray-400 font-mono leading-relaxed ${
                  ocrExpanded ? '' : 'max-h-32 overflow-hidden'
                }`}
              >
                {String(ocrText)}
              </pre>
              {!ocrExpanded && String(ocrText).split('\n').length > 8 && (
                <div className="relative -mt-8 h-8 bg-gradient-to-t from-gray-900 to-transparent" />
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
