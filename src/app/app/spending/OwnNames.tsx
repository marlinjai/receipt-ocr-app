'use client';

import { useId, useState } from 'react';
import { MAX_OWN_NAMES, MAX_OWN_NAME_LENGTH } from '@/lib/spending/own-names';

/**
 * What a refused change of the own names means, in words a person can act on;
 * null for any other failure. Shared by Ausgaben and Finanzen, Einstellungen,
 * which both edit the same list.
 */
export function ownNamesMessage(detail: string | undefined): string | null {
  if (detail === 'invalid_names') return 'Ein Name braucht mindestens zwei Buchstaben oder Ziffern, zum Beispiel Vor- und Nachname.';
  if (detail === 'name_too_long') return `Ein Name darf höchstens ${MAX_OWN_NAME_LENGTH} Zeichen lang sein.`;
  if (detail === 'too_many_names') return `Es lassen sich höchstens ${MAX_OWN_NAMES} eigene Namen merken.`;
  if (detail === 'name_listed') return 'Dieser Name steht schon in der Liste, vielleicht in einer anderen Schreibweise.';
  if (detail === 'name_not_listed') return 'Dieser Name steht nicht mehr in der Liste, vielleicht wurde er auf einer anderen Seite entfernt. Bitte die Seite neu laden.';
  return null;
}

/**
 * The owner's own names: money to or from a counterparty carrying one of them
 * is an own transfer. While the list is empty it asks for a name up front
 * (the sign-in tells the app no name to start from); afterwards it is a quiet
 * list to change.
 */
export default function OwnNames({
  names,
  canWrite,
  pending,
  error,
  notice,
  onChange,
}: {
  names: readonly string[];
  canWrite: boolean;
  pending: boolean;
  error: string | null;
  /** What the last change did, for the status line. */
  notice: string | null;
  /** Add or take out one name; resolves true when the server took it. */
  onChange: (change: { add: string } | { remove: string }) => Promise<boolean>;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const explanation = (
    <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
      Zahlungen an oder von diesen Namen sind Umbuchungen zwischen eigenen Konten: keine Ausgabe, kein Beleg nötig, keine Benachrichtigung. Groß- und
      Kleinschreibung, Akzente, Satzzeichen und die Reihenfolge der Wörter zählen nicht; Rechtsformen wie UG oder GmbH schon. Eine Antwort zu einer
      Gegenseite unter Finanzen als geschäftlich oder gemischt geht vor; „privat“ dort (eine Privatentnahme) bleibt für die Ausgaben eine Umbuchung.
    </p>
  );
  const editor = canWrite && (
    <>
      {names.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {names.map((n) => (
            <li key={n} className="inline-flex items-center gap-1 rounded-full border py-0.5 pr-0.5 pl-2.5 text-sm" style={{ borderColor: 'var(--border)' }}>
              {n}
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" disabled={pending} aria-label={`${n} aus den eigenen Namen entfernen`} onClick={() => void onChange({ remove: n })}>
                Entfernen
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-2 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const name = draft.trim();
          // A saved name leaves the field; a refused one stays there to be corrected.
          if (name) void onChange({ add: name }).then((saved) => saved && setDraft(''));
        }}
      >
        <label className="sr-only" htmlFor={`${id}-name`}>
          Eigener Name, wie die Bank ihn schreibt
        </label>
        <input
          id={`${id}-name`}
          className="ui-input"
          style={{ width: 'auto', minWidth: '12rem', flex: '1 1 14rem' }}
          placeholder="Vor- und Nachname, wie auf dem Kontoauszug"
          value={draft}
          maxLength={MAX_OWN_NAME_LENGTH}
          disabled={pending}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="ui-btn ui-btn-primary ui-btn-sm" disabled={pending || !draft.trim()} aria-label="Eigenen Namen hinzufügen">
          Hinzufügen
        </button>
      </form>
      {error && (
        <p id={`${id}-error`} className="ui-note ui-note-danger mt-2" role="alert">
          {error}
        </p>
      )}
    </>
  );
  // Always rendered, so a screen reader announces what a change did.
  const status = (
    <p className={notice ? 'ui-note ui-note-ok mt-2' : 'sr-only'} role="status">
      {notice ?? ''}
    </p>
  );
  if (names.length === 0) {
    return (
      <section className="ui-note ui-note-warn mt-4" aria-labelledby={`${id}-title`}>
        <h2 id={`${id}-title`} className="text-sm font-semibold">
          Eigene Namen
        </h2>
        <p className="mt-1 text-sm">
          Noch kein eigener Name hinterlegt. Überweisungen an sich selbst (eigene Spaces, Tagesgeld, ein anderes eigenes Konto) zählen deshalb als Ausgabe und
          fragen nach einem Beleg.
          {canWrite
            ? ' Trag deinen Namen so ein, wie die Bank ihn schreibt; mehrere Schreibweisen sind möglich.'
            : ' Eintragen kann ihn, wer in diesem Arbeitsbereich ändern darf.'}
        </p>
        {explanation}
        {editor}
        {status}
      </section>
    );
  }
  return (
    <details className="glass-panel ui-disclosure mt-4 rounded-xl p-4">
      <summary className="cursor-pointer text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
        Eigene Namen ({names.length})
      </summary>
      {explanation}
      {canWrite ? editor : <p className="mt-2 text-sm">{names.join(', ')}</p>}
      {status}
    </details>
  );
}
