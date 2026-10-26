'use client';

import { useEffect, useId, useState } from 'react';
import { PURCHASE_KINDS, PURCHASE_KIND_LABELS, type PurchaseKind } from '@/lib/line-items/kinds';
import { differenceText, money } from '@/lib/line-items/format';
import type { ReceiptLinesView } from '@/lib/line-items/service';
import { getReceiptLines, setReceiptLineKind, type LineItemsResult } from '@/app/app/line-items-actions';

function failureText(result: Extract<LineItemsResult<unknown>, { ok: false }>): string {
  if (result.error === 'unauthorized') return 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und neu anmelden.';
  if (result.error === 'forbidden') return 'Für diesen Arbeitsbereich fehlt die Berechtigung zum Ändern.';
  if (result.error === 'not_found') return 'Diese Position gibt es nicht mehr, vielleicht wurde der Beleg neu gelesen. Bitte die Seite neu laden.';
  if (result.error === 'invalid_input') return 'Diese Art gibt es nicht. Bitte eine aus der Liste wählen.';
  return 'Das hat nicht geklappt. Bitte noch einmal versuchen; wenn es wieder scheitert, die Seite neu laden.';
}

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; view: ReceiptLinesView };

/**
 * The "Positionen" section of the receipt view: every printed line with what
 * it cost and its kind of purchase. A kind can be changed here; the answer is
 * remembered for the same text at the same shop. An amount is never changed
 * here: the receipt is read again for that ("Seite neu lesen").
 */
export default function ReceiptLinesSection({ rowId, version }: { rowId: string; /** Changes when the receipt was saved or read again: the lines are loaded afresh. */ version: string }) {
  const id = useId();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [lineError, setLineError] = useState<{ lineId: string; message: string } | null>(null);

  useEffect(() => {
    let current = true;
    getReceiptLines(rowId)
      .then((result) => current && setState(result.ok ? { kind: 'ready', view: result.value } : { kind: 'error', message: failureText(result) }))
      .catch(() => current && setState({ kind: 'error', message: failureText({ ok: false, error: 'failed' }) }));
    return () => {
      current = false;
    };
  }, [rowId, version, attempt]);

  const choose = async (lineId: string, kind: PurchaseKind) => {
    setBusyLine(lineId);
    setLineError(null);
    try {
      const result = await setReceiptLineKind(rowId, lineId, kind);
      if (result.ok) setState({ kind: 'ready', view: result.value });
      else setLineError({ lineId, message: failureText(result) });
    } catch {
      setLineError({ lineId, message: failureText({ ok: false, error: 'failed' }) });
    } finally {
      setBusyLine(null);
    }
  };

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4" data-theme="dark">
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-gray-500">Positionen</h3>
      {state.kind === 'loading' && (
        <p className="text-sm" style={{ color: 'var(--muted)' }} role="status">
          Positionen werden geladen…
        </p>
      )}
      {state.kind === 'error' && (
        <div className="ui-note ui-note-danger" role="alert">
          <p>{state.message}</p>
          <button type="button" className="ui-btn ui-btn-sm mt-2" onClick={() => setAttempt((a) => a + 1)}>
            Erneut laden
          </button>
        </div>
      )}
      {state.kind === 'ready' && <LinesBody view={state.view} idPrefix={id} busyLine={busyLine} lineError={lineError} onChoose={choose} />}
    </div>
  );
}

function LinesBody({
  view,
  idPrefix,
  busyLine,
  lineError,
  onChoose,
}: {
  view: ReceiptLinesView;
  idPrefix: string;
  busyLine: string | null;
  lineError: { lineId: string; message: string } | null;
  onChoose: (lineId: string, kind: PurchaseKind) => void;
}) {
  const { reading, lines, check, currency } = view;
  if (!reading) {
    return (
      <p className="text-sm text-gray-400">
        Die Positionen dieses Belegs wurden noch nicht gelesen. Sie kommen mit dem nächsten Lauf von „Positionen lesen“ auf der Belegseite oder dem täglichen Lauf.
      </p>
    );
  }
  if (reading.outcome === 'no_text') return <p className="text-sm text-gray-400">Für diesen Beleg ist kein erkannter Text gespeichert, daher gibt es keine Positionen. „Seite neu lesen“ liest sie von der Seite.</p>;
  if (reading.outcome === 'failed') return <p className="text-sm text-gray-400">Die Positionen konnten noch nicht gelesen werden. Der nächste Lauf versucht es erneut.</p>;
  if (lines.length === 0) return <p className="text-sm text-gray-400">Auf dem Beleg wurden keine Positionen gefunden.</p>;
  return (
    <>
      {check && !check.addsUp && (
        <p className="ui-note ui-note-warn mb-3" role="status">
          {differenceText(check, currency)}. Der Gesamtbetrag zählt; die Differenz steht in der Übersicht als „nicht aufgeschlüsselt“.
        </p>
      )}
      {reading.textCut && <p className="ui-note mb-3">Der gespeicherte Text war sehr lang und wurde gekürzt gelesen: Positionen aus der Mitte können fehlen.</p>}
      <ul className="divide-y divide-gray-800">
        {lines.map((line) => {
          const selectId = `${idPrefix}-kind-${line.id}`;
          return (
            <li key={line.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm text-gray-200">{line.text}</p>
                {line.quantity !== null && line.quantity !== 1 && (
                  <p className="text-xs text-gray-500">
                    {new Intl.NumberFormat('de-DE', { maximumFractionDigits: 3 }).format(line.quantity)}
                    {line.unitPriceCents !== null ? ` × ${money(line.unitPriceCents, currency)}` : ''}
                  </p>
                )}
              </div>
              <span className="shrink-0 text-sm tabular-nums text-gray-200">{money(line.grossCents, currency)}</span>
              <label htmlFor={selectId} className="sr-only">
                Art von {line.text}
              </label>
              <select
                id={selectId}
                className="ui-input w-full text-sm sm:w-56"
                value={line.kind}
                disabled={busyLine !== null}
                aria-describedby={line.answered ? `${selectId}-note` : undefined}
                onChange={(e) => onChoose(line.id, e.target.value as PurchaseKind)}
              >
                {PURCHASE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {PURCHASE_KIND_LABELS[k]}
                    {k === line.readKind && line.answered ? ' (gelesen)' : ''}
                  </option>
                ))}
              </select>
              {line.answered && (
                <p id={`${selectId}-note`} className="w-full text-xs text-gray-500">
                  Von dir zugeordnet, gilt für diesen Text bei diesem Händler.
                </p>
              )}
              {lineError?.lineId === line.id && (
                <p className="ui-note ui-note-danger w-full" role="alert">
                  {lineError.message}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
