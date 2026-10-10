'use client';

import { useState } from 'react';
import type { GroupOption } from '@/lib/groups/view';

const inputStyle = {
  background: 'var(--background)',
  border: '1px solid var(--border)',
  color: 'var(--foreground)',
} as const;

const buttonClass = 'px-2.5 py-1 text-xs font-medium rounded-md transition-colors duration-150 disabled:opacity-50';
const buttonStyle = { background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' } as const;

const receiptsWord = (n: number) => (n === 1 ? '1 Beleg' : `${n} Belege`);
/** After "mit": the dative. */
const withReceipts = (n: number) => (n === 1 ? '1 Beleg' : `${n} Belegen`);

/**
 * The controls for groups, next to the bulk edit: create a group (with the
 * selected receipts in it), put the selected receipts into an existing group,
 * take them out again. A group in the selection is never moved, so every label
 * says how many RECEIPTS the action applies to.
 */
export default function GroupBar({
  groups,
  receiptCount,
  inGroupCount,
  busy,
  onCreate,
  onMoveInto,
  onTakeOut,
}: {
  groups: GroupOption[];
  /** The selected rows that are receipts. */
  receiptCount: number;
  /** Of those, the ones that lie in a group. */
  inGroupCount: number;
  busy: boolean;
  /** Resolves to true when the group was created, so the form can close. */
  onCreate: (name: string) => Promise<boolean>;
  onMoveInto: (groupId: string) => void;
  onTakeOut: () => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const submit = async () => {
    if (!name.trim() || busy) return;
    if (await onCreate(name)) {
      setName('');
      setNaming(false);
    }
  };

  return (
    <div className="inline-flex flex-wrap items-center gap-1.5">
      {naming ? (
        <form
          className="inline-flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setNaming(false);
                setName('');
              }
            }}
            maxLength={120}
            placeholder="Name der Gruppe"
            aria-label="Name der neuen Gruppe"
            className="px-2 py-1 text-xs rounded-md"
            style={{ ...inputStyle, width: '12rem' }}
          />
          <button type="submit" disabled={busy || !name.trim()} className={`${buttonClass} bg-blue-600 text-white hover:bg-blue-700`}>
            {busy ? 'Bitte warten…' : receiptCount > 0 ? `Mit ${withReceipts(receiptCount)} anlegen` : 'Leer anlegen'}
          </button>
          <button
            type="button"
            disabled={busy}
            className={buttonClass}
            style={buttonStyle}
            onClick={() => {
              setNaming(false);
              setName('');
            }}
          >
            Abbrechen
          </button>
        </form>
      ) : (
        <button
          type="button"
          disabled={busy}
          className={buttonClass}
          style={buttonStyle}
          onClick={() => setNaming(true)}
          title="Eine Gruppe fasst Belege zusammen und zeigt ihre Summe. Sie zählt selbst nie als Beleg."
        >
          {receiptCount > 0 ? `Neue Gruppe mit ${withReceipts(receiptCount)}` : 'Neue Gruppe'}
        </button>
      )}
      {receiptCount > 0 && groups.length > 0 && !naming && (
        <select
          value=""
          disabled={busy}
          onChange={(e) => {
            if (e.target.value) onMoveInto(e.target.value);
          }}
          className="px-2 py-1 text-xs rounded-md"
          style={inputStyle}
          aria-label={`${receiptsWord(receiptCount)} in eine Gruppe legen`}
        >
          <option value="">In Gruppe legen…</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      )}
      {inGroupCount > 0 && !naming && (
        <button type="button" disabled={busy} className={buttonClass} style={buttonStyle} onClick={onTakeOut}>
          {receiptsWord(inGroupCount)} aus der Gruppe nehmen
        </button>
      )}
    </div>
  );
}
