'use client';

import { useId, useState } from 'react';

/**
 * "Was ist das?": the person's short description of a counterparty or vendor ("Getränkelieferdienst, Wasser",
 * "kommt drauf an"). Saved as one of their statements; both the receipt assignment and the counterparty
 * classifier are given it (plan 2026-11-07-learned-assignment, decision 8). Empty and saved removes it.
 */
export default function WhatField({ label, value, busy, onSave }: { label: string; value: string | null; busy: boolean; onSave: (answer: string) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(value ?? '');
  const changed = draft.trim() !== (value ?? '');
  return (
    <form
      className="mt-1.5 flex flex-wrap items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) onSave(draft.trim());
      }}
    >
      <label htmlFor={`${id}-what`} className="text-xs" style={{ color: 'var(--muted)' }}>
        Was ist das?
      </label>
      <input
        id={`${id}-what`}
        className="ui-input w-56 max-w-full text-xs"
        value={draft}
        maxLength={120}
        placeholder="z. B. Getränkelieferdienst, Wasser"
        aria-label={`Was ist ${label}?`}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="submit" className="ui-btn ui-btn-sm" disabled={busy || !changed}>
        {draft.trim() || !value ? 'Speichern' : 'Entfernen'}
      </button>
    </form>
  );
}
