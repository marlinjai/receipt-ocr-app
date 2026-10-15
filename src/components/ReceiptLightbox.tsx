'use client';

import { useEffect, useRef } from 'react';
import ReceiptViewer, { type ViewerFile } from './meals/ReceiptViewer';
import ToolIcon from './ui/ToolIcon';
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
  const closeRef = useRef<HTMLButtonElement>(null);

  // Move focus into the dialog on open and hand it back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, []);

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
        className="flex flex-col gap-2"
        style={{ width: 'min(92vw, 1100px)', height: '90vh' }}
      >
        {/* Its own row above the viewer, so it never covers the viewer's tools in the corner. */}
        <div className="flex justify-end">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            aria-label="Close preview"
            title="Close preview (Esc)"
          >
            <ToolIcon name="close" />
          </button>
        </div>
        <ReceiptViewer files={[file]} onRotate={onRotate} lang="en" className="min-h-0 flex-1" />
      </div>
    </div>
  );
}
