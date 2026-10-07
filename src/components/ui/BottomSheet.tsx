'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

interface BottomSheetProps {
  open: boolean;
  title: string;
  /** Escape, the backdrop and the close button all call this. */
  onClose: () => void;
  children: ReactNode;
}

/**
 * A modal sheet anchored to the bottom edge, for the phone: the follow-up
 * form after a capture. Sized in small-viewport units so the browser's own
 * toolbars never cover its buttons. Centered and width-capped on larger screens.
 */
export default function BottomSheet({ open, title, onClose, children }: BottomSheetProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    // The page behind must not scroll while the sheet is open.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="ui-dialog-backdrop fixed inset-0 z-[60] flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-sheet flex max-h-[92svh] w-full max-w-xl flex-col rounded-t-2xl border outline-none sm:rounded-2xl"
        style={{ background: '#17171c', borderColor: 'var(--glass-border)' }}
        data-theme="dark"
      >
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
          <h2 id={titleId} className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
            {title}
          </h2>
          <button type="button" className="ui-btn ui-btn-sm" onClick={onClose}>
            Schließen
          </button>
        </div>
        <div className="overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">{children}</div>
      </div>
    </div>
  );
}
