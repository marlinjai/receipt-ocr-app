'use client';

import { useEffect } from 'react';
import ReceiptViewer, { type ViewerFile } from './meals/ReceiptViewer';
import type { Rotation } from '@/lib/meals/viewer-state';

/**
 * Fullscreen receipt preview: the receipt viewer (rotate, zoom, drag, fit) at
 * the size of the window. Escape or a click on the backdrop closes it.
 */
export default function ReceiptLightbox({
  file,
  onRotate,
  onClose,
}: {
  file: ViewerFile;
  onRotate?: (file: ViewerFile, rotation: Rotation) => Promise<boolean>;
  onClose: () => void;
}) {
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
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Receipt preview"
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'relative', width: 'min(92vw, 1100px)', height: '90vh' }}
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
        <ReceiptViewer files={[file]} onRotate={onRotate} lang="en" className="h-full" />
      </div>
    </div>
  );
}
