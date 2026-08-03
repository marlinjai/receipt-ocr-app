'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Column, Row } from '@marlinjai/data-table-core';
import ReceiptLightbox from './ReceiptLightbox';

interface ReceiptImagePreviewProps {
  columns: Column[];
  rows: Row[];
  /** Upload a file into a row's Receipt Image (cell click-to-upload + drop). */
  onUploadFile?: (rowId: string, file: File) => Promise<void>;
}

/**
 * Transforms the "Receipt Image" URL column cells from plain text links
 * into image thumbnails, and provides a lightbox modal for full-size viewing.
 *
 * This component observes the DOM after the data-table renders and replaces
 * the URL anchor tags in the Receipt Image column with <img> thumbnails.
 */
export default function ReceiptImagePreview({ columns, rows, onUploadFile }: ReceiptImagePreviewProps) {
  // The raw CELL url; ReceiptLightbox derives the real file url + PDF-ness.
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const receiptImageColIndex = columns.findIndex((c) => c.name === 'Receipt Image');

  // Wire drag&drop (and, for empty cells, click-to-upload) onto a cell. The
  // element shows '…' while uploading and '!' with the reason on failure; a
  // successful upload updates the row, which re-renders the cell as a
  // thumbnail via the normal transform pass.
  const wireUpload = useCallback(
    (el: HTMLElement, rowId: string, clickToPick: boolean) => {
      if (!onUploadFile) return;
      const run = (file: File) => {
        const label = el.querySelector('.receipt-upload-label') as HTMLElement | null;
        if (label) label.textContent = '…';
        onUploadFile(rowId, file).catch((err: unknown) => {
          if (label) label.textContent = '!';
          el.title = err instanceof Error ? err.message : 'Upload failed';
        });
      };
      if (clickToPick) {
        el.style.cursor = 'pointer';
        el.title = 'Upload a receipt file (or drop one here)';
        el.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.pdf,.png,.jpg,.jpeg';
          input.onchange = () => {
            if (input.files?.[0]) run(input.files[0]);
          };
          input.click();
        });
      }
      el.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        el.style.outline = '1px solid #3b82f6';
      });
      el.addEventListener('dragleave', () => {
        el.style.outline = '';
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.style.outline = '';
        const file = e.dataTransfer?.files?.[0];
        if (file) run(file);
      });
    },
    [onUploadFile],
  );

  const transformCells = useCallback(() => {
    if (receiptImageColIndex < 0) return;

    const dashboard = containerRef.current?.closest('.h-screen');
    if (!dashboard) return;

    const tableEl = dashboard.querySelector('table');
    if (!tableEl) return;

    const bodyRows = tableEl.querySelectorAll('tbody tr');

    bodyRows.forEach((tr) => {
      const cells = tr.querySelectorAll('td');
      // Account for the checkbox column (+1 offset)
      const hasCheckbox = cells.length > columns.length;
      const cellIndex = receiptImageColIndex + (hasCheckbox ? 1 : 0);
      const td = cells[cellIndex];
      if (!td) return;

      const urlCell = td.querySelector('.dt-cell-url') as HTMLElement | null;
      if (!urlCell) return;

      const anchor = urlCell.querySelector('a');
      const url = anchor?.getAttribute('href') || '';

      // Already transformed and still current? Done. If the underlying URL
      // changed (upload/replace re-rendered the cell), rebuild OUR overlay.
      const existingOverlay = urlCell.querySelector(':scope > .receipt-thumbnail') as HTMLElement | null;
      if (existingOverlay) {
        if (existingOverlay.dataset.url === url) return;
        existingOverlay.remove();
      }

      // CRITICAL: React owns this cell's children. Never remove them
      // (innerHTML = '' here made React's later reconciliation crash with
      // "removeChild ... not a child of this node" and took the whole page
      // down). Hide them and append our overlay alongside instead.
      for (const child of Array.from(urlCell.children)) {
        if (!(child as HTMLElement).classList.contains('receipt-thumbnail')) {
          (child as HTMLElement).style.display = 'none';
        }
      }

      const rowId = tr.getAttribute('data-row-id');

      if (!url) {
        // No image — an upload affordance (click or drop) when wired, else a
        // plain placeholder.
        const canUpload = Boolean(onUploadFile && rowId);
        const placeholder = document.createElement('div');
        placeholder.className = 'receipt-thumbnail';
        placeholder.style.cssText =
          'display:flex;align-items:center;justify-content:center;padding:4px 8px;height:100%;';
        const icon = document.createElement('div');
        icon.className = 'receipt-upload-label';
        icon.style.cssText =
          'width:28px;height:36px;border-radius:4px;background:rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center;color:#555;font-size:12px;';
        icon.textContent = canUpload ? '+' : '--';
        placeholder.appendChild(icon);
        if (canUpload) wireUpload(placeholder, rowId!, true);
        placeholder.dataset.url = '';
        urlCell.appendChild(placeholder);
        (urlCell as HTMLElement).style.overflow = 'visible';
        (urlCell as HTMLElement).style.padding = '0';
        return;
      }

      // Replace URL text with thumbnail image
      const wrapper = document.createElement('div');
      wrapper.className = 'receipt-thumbnail';
      wrapper.style.cssText =
        'display:flex;align-items:center;justify-content:center;padding:4px 8px;cursor:pointer;height:100%;';

      const img = document.createElement('img');
      img.src = url;
      img.alt = 'Receipt';
      img.style.cssText =
        'max-height:36px;max-width:100%;border-radius:4px;object-fit:contain;transition:opacity 0.2s;';
      img.loading = 'lazy';

      img.onerror = () => {
        wrapper.innerHTML = '';
        const fallback = document.createElement('div');
        fallback.style.cssText =
          'width:28px;height:36px;border-radius:4px;background:rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:center;color:#666;font-size:10px;';
        fallback.textContent = 'N/A';
        wrapper.appendChild(fallback);
      };

      wrapper.appendChild(img);

      wrapper.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setLightboxUrl(url);
      });

      // Dropping a file on a filled cell replaces the row's file.
      if (rowId) wireUpload(wrapper, rowId, false);

      wrapper.dataset.url = url;
      urlCell.appendChild(wrapper);
      (urlCell as HTMLElement).style.overflow = 'visible';
      (urlCell as HTMLElement).style.padding = '0';
    });
  }, [receiptImageColIndex, columns.length, onUploadFile, wireUpload]);

  useEffect(() => {
    if (receiptImageColIndex < 0) return;

    // Initial transform after the table renders
    const timeout = setTimeout(transformCells, 100);

    // Watch only the table tbody for DOM changes (new rows, re-renders)
    // This avoids firing on unrelated mutations (e.g. search input keystrokes)
    const dashboard = containerRef.current?.closest('.h-screen');
    const tbody = dashboard?.querySelector('table tbody');
    if (!tbody) return () => clearTimeout(timeout);

    const observer = new MutationObserver(() => {
      requestAnimationFrame(transformCells);
    });

    observer.observe(tbody, {
      childList: true,
      subtree: true,
    });

    return () => {
      clearTimeout(timeout);
      observer.disconnect();
    };
  }, [receiptImageColIndex, transformCells, rows]);

  return (
    <>
      {/* Invisible anchor for DOM queries */}
      <div ref={containerRef} style={{ display: 'none' }} />

      {lightboxUrl && <ReceiptLightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}
    </>
  );
}
