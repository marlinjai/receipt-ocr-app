'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Column, Row } from '@marlinjai/data-table-core';
import ReceiptLightbox from './ReceiptLightbox';

interface ReceiptImagePreviewProps {
  columns: Column[];
  rows: Row[];
}

/**
 * Transforms the "Receipt Image" URL column cells from plain text links
 * into image thumbnails, and provides a lightbox modal for full-size viewing.
 *
 * This component observes the DOM after the data-table renders and replaces
 * the URL anchor tags in the Receipt Image column with <img> thumbnails.
 */
export default function ReceiptImagePreview({ columns, rows }: ReceiptImagePreviewProps) {
  // The raw CELL url; ReceiptLightbox derives the real file url + PDF-ness.
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const receiptImageColIndex = columns.findIndex((c) => c.name === 'Receipt Image');

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

      // Skip if already transformed
      if (td.querySelector('.receipt-thumbnail')) return;

      const urlCell = td.querySelector('.dt-cell-url');
      if (!urlCell) return;

      const anchor = urlCell.querySelector('a');
      const url = anchor?.getAttribute('href') || '';

      if (!url) {
        // No image — show placeholder
        const placeholder = document.createElement('div');
        placeholder.className = 'receipt-thumbnail';
        placeholder.style.cssText =
          'display:flex;align-items:center;justify-content:center;padding:4px 8px;height:100%;';
        const icon = document.createElement('div');
        icon.style.cssText =
          'width:28px;height:36px;border-radius:4px;background:rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center;color:#555;font-size:10px;';
        icon.textContent = '--';
        placeholder.appendChild(icon);
        urlCell.innerHTML = '';
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

      urlCell.innerHTML = '';
      urlCell.appendChild(wrapper);
      (urlCell as HTMLElement).style.overflow = 'visible';
      (urlCell as HTMLElement).style.padding = '0';
    });
  }, [receiptImageColIndex, columns.length]);

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
