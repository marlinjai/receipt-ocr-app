'use client';

import { useState } from 'react';
import type { MealFile } from '@/lib/meals/types';

/** The receipt beside the form: the image, or an embedded viewer for a PDF. */
export default function ReceiptPreview({ files }: { files: MealFile[] }) {
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const file = files[Math.min(index, files.length - 1)];

  if (!file) {
    return (
      <div className="ui-note flex min-h-40 items-center justify-center text-center" style={{ color: 'var(--muted)' }}>
        Zu diesem Beleg ist keine Datei hinterlegt.
      </div>
    );
  }

  return (
    <div>
      {failed.has(file.fileId) ? (
        <div className="ui-note ui-note-danger">
          Der Beleg „{file.originalName}“ konnte nicht geladen werden.{' '}
          <a href={file.fileUrl} target="_blank" rel="noreferrer" className="underline">
            In neuem Tab öffnen
          </a>
        </div>
      ) : file.mimeType === 'application/pdf' ? (
        <iframe
          src={`${file.fileUrl}#toolbar=0&navpanes=0`}
          title={`Beleg ${file.originalName}`}
          className="h-[60svh] w-full rounded-lg border-0"
          style={{ background: '#1e1e2e' }}
        />
      ) : (
        <a href={file.fileUrl} target="_blank" rel="noreferrer" title="Beleg in voller Größe öffnen" className="block">
          {/* The auth-gated file proxy cannot go through the image optimizer. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={file.fileUrl}
            alt={`Beleg ${file.originalName}`}
            className="max-h-[70svh] w-full rounded-lg object-contain"
            style={{ background: 'rgba(0,0,0,0.3)' }}
            onError={() => setFailed((s) => new Set(s).add(file.fileId))}
          />
        </a>
      )}
      {files.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <button key={f.fileId} type="button" className="ui-btn ui-btn-sm" aria-pressed={i === index} onClick={() => setIndex(i)}>
              Datei {i + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
