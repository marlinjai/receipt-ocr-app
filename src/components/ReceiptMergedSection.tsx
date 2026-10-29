'use client';

import { useEffect, useState } from 'react';
import { getMergedReceipts, restoreMerged, type DuplicateResult, type MergedReceiptView } from '@/app/app/duplicate-actions';

function failureText(result: Extract<DuplicateResult<unknown>, { ok: false }>): string {
  if (result.error === 'unauthorized') return 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und neu anmelden.';
  if (result.error === 'forbidden') return 'Für diesen Arbeitsbereich fehlt die Berechtigung zum Ändern.';
  if (result.error === 'not_found') return 'Dieser Beleg ist nicht mehr zusammengeführt, vielleicht wurde er schon wiederhergestellt. Bitte die Seite neu laden.';
  return 'Das hat nicht geklappt. Bitte noch einmal versuchen; wenn es wieder scheitert, die Seite neu laden.';
}

function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * "Zusammengeführt" in the receipt view: the receipts the app archived into
 * this one because they are the same receipt (the same file, or the same
 * invoice number from the same vendor; plan 2026-10-29-invoice-number-duplicates).
 * Archived receipts are shown nowhere else, so this is where one is brought
 * back. Shows nothing while there is nothing merged.
 */
export default function ReceiptMergedSection({
  rowId,
  version,
  onRestored,
}: {
  rowId: string;
  /** Changes when the receipt was saved or read again: the list is loaded afresh. */
  version: string;
  /** Reload the table: the restored receipt is a receipt of its own again. */
  onRestored?: () => void;
}) {
  const [merged, setMerged] = useState<MergedReceiptView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    getMergedReceipts(rowId)
      .then((result) => {
        if (!current) return;
        if (result.ok) {
          setMerged(result.value);
          setLoadError(null);
        } else setLoadError(failureText(result));
      })
      .catch(() => current && setLoadError(failureText({ ok: false, error: 'failed' })));
    return () => {
      current = false;
    };
  }, [rowId, version]);

  const restore = async (entry: MergedReceiptView) => {
    setBusy(entry.rowId);
    setActionError(null);
    setRestored(null);
    try {
      const result = await restoreMerged(rowId, entry.rowId);
      if (result.ok) {
        setMerged(result.value);
        setRestored(entry.name);
        onRestored?.();
      } else setActionError(failureText(result));
    } catch {
      setActionError(failureText({ ok: false, error: 'failed' }));
    } finally {
      setBusy(null);
    }
  };

  if (merged.length === 0 && !loadError && !restored && !actionError) return null;

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4" data-theme="dark">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">Zusammengeführt</h3>
      {loadError && (
        <p className="ui-note ui-note-danger" role="alert">
          {loadError}
        </p>
      )}
      {merged.length > 0 && (
        <>
          <p className="mb-2 text-xs" style={{ color: 'var(--dt-text-secondary)' }}>
            Diese Belege waren derselbe Beleg wie dieser und wurden archiviert. Ihre Zahlungen und Dateien hängen jetzt hier. Wiederherstellen macht einen wieder zu einem eigenen Beleg; die App führt die beiden dann nicht mehr zusammen.
          </p>
          <ul className="m-0 list-none space-y-2 p-0">
            {merged.map((entry) => (
              <li key={entry.rowId} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="min-w-0" style={{ color: 'var(--foreground)' }}>
                  „{entry.name}“:{' '}
                  {entry.reason === 'same_file' ? 'dieselbe Datei' : `gleiche Rechnungsnummer${entry.invoiceNumber ? ` ${entry.invoiceNumber}` : ''}`}
                  {day(entry.mergedAt) ? `, am ${day(entry.mergedAt)}` : ''}
                </span>
                <button type="button" className="ui-btn ui-btn-sm shrink-0" disabled={busy !== null} onClick={() => void restore(entry)} aria-label={`${entry.name} wiederherstellen`}>
                  {busy === entry.rowId ? 'Stellt wieder her …' : 'Wiederherstellen'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div aria-live="polite">
        {restored && (
          <p className="ui-note ui-note-ok mt-2" role="status">
            „{restored}“ ist wieder ein eigener Beleg.
          </p>
        )}
        {actionError && (
          <p className="ui-note ui-note-danger mt-2" role="alert">
            {actionError}
          </p>
        )}
      </div>
    </div>
  );
}
