'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Column, Row } from '@marlinjai/data-table-core';

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
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [lightboxIsPdf, setLightboxIsPdf] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lightboxUrlRef = useRef<string | null>(null);

  // Keep ref in sync for use in DOM event handlers
  useEffect(() => {
    lightboxUrlRef.current = lightboxUrl;
  }, [lightboxUrl]);

  const receiptImageColIndex = columns.findIndex((c) => c.name === 'Receipt Image');

  const getFullUrl = useCallback((url: string): string => {
    if (url.endsWith('/thumbnail')) {
      return url.replace(/\/thumbnail$/, '');
    }
    return url;
  }, []);

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

      const fullUrl = getFullUrl(url);

      wrapper.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setLightboxUrl(fullUrl);
        setLightboxIsPdf(url.endsWith('/thumbnail'));
      });

      urlCell.innerHTML = '';
      urlCell.appendChild(wrapper);
      (urlCell as HTMLElement).style.overflow = 'visible';
      (urlCell as HTMLElement).style.padding = '0';
    });
  }, [receiptImageColIndex, columns.length, getFullUrl]);

  useEffect(() => {
    if (receiptImageColIndex < 0) return;

    // Initial transform after the table renders
    const timeout = setTimeout(transformCells, 100);

    // Watch for DOM changes (new rows, re-renders)
    const dashboard = containerRef.current?.closest('.h-screen');
    if (!dashboard) return () => clearTimeout(timeout);

    const observer = new MutationObserver(() => {
      requestAnimationFrame(transformCells);
    });

    observer.observe(dashboard, {
      childList: true,
      subtree: true,
    });

    return () => {
      clearTimeout(timeout);
      observer.disconnect();
    };
  }, [receiptImageColIndex, transformCells, rows]);

  // Close lightbox on Escape key
  useEffect(() => {
    if (!lightboxUrl) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxUrl(null);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [lightboxUrl]);

  return (
    <>
      {/* Invisible anchor for DOM queries */}
      <div ref={containerRef} style={{ display: 'none' }} />

      {/* Lightbox Modal */}
      {lightboxUrl && (
        <div
          onClick={() => setLightboxUrl(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            backdropFilter: 'blur(4px)',
            cursor: 'zoom-out',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'relative',
              maxWidth: '90vw',
              maxHeight: '90vh',
              cursor: 'default',
            }}
          >
            {/* Close button */}
            <button
              onClick={() => setLightboxUrl(null)}
              style={{
                position: 'absolute',
                top: -12,
                right: -12,
                width: 32,
                height: 32,
                borderRadius: '50%',
                border: '1px solid rgba(255,255,255,0.2)',
                background: 'rgba(0,0,0,0.6)',
                color: '#fff',
                fontSize: 18,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1,
              }}
              aria-label="Close preview"
            >
              &times;
            </button>

            {lightboxIsPdf ? (
              // For PDFs, open the actual file in an iframe
              <iframe
                src={lightboxUrl}
                title="Receipt preview"
                style={{
                  width: '80vw',
                  height: '85vh',
                  maxWidth: 900,
                  border: 'none',
                  borderRadius: 8,
                  background: '#1e1e2e',
                }}
              />
            ) : (
              // For images, show the full-resolution image
              <img
                src={lightboxUrl}
                alt="Receipt full size"
                style={{
                  maxWidth: '90vw',
                  maxHeight: '90vh',
                  objectFit: 'contain',
                  borderRadius: 8,
                  boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                }}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
