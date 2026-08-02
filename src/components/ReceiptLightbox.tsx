'use client';

import { useEffect } from 'react';

/**
 * Fullscreen receipt preview: PDFs load into an iframe, raster images render
 * full-size. The single lightbox implementation, shared by the table cells
 * (ReceiptImagePreview) and the row detail panel.
 *
 * `url` is the CELL value: `/api/files/<id>/thumbnail` for PDFs (the suffix is
 * stripped to reach the real file) or a bare image URL.
 */
export function lightboxTarget(url: string): { fullUrl: string; isPdf: boolean } {
  const isPdf = url.endsWith('/thumbnail');
  return { fullUrl: isPdf ? url.replace(/\/thumbnail$/, '') : url, isPdf };
}

export default function ReceiptLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  const { fullUrl, isPdf } = lightboxTarget(url);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
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
        style={{ position: 'relative', maxWidth: '90vw', maxHeight: '90vh', cursor: 'default' }}
      >
        <button
          onClick={onClose}
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

        {isPdf ? (
          <iframe
            src={fullUrl}
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
          <img
            src={fullUrl}
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
  );
}
