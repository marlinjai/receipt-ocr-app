'use client';

import { useState } from 'react';

/** Editable, workspace-scoped notes block (reconciliation / attribution commentary). */
export default function NotesPanel({ initial }: { initial: string }) {
  const [body, setBody] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/overview/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      setMsg(res.ok ? 'Saved.' : 'Save failed');
      if (res.ok) setEditing(false);
    } catch {
      setMsg('Save failed');
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <div>
        {body.trim() ? (
          <p className="text-xs whitespace-pre-wrap" style={{ color: 'var(--dt-text-secondary)' }}>{body}</p>
        ) : (
          <p className="text-xs italic" style={{ color: 'var(--dt-text-secondary)' }}>No notes yet.</p>
        )}
        <button onClick={() => setEditing(true)} className="text-xs mt-2" style={{ color: 'var(--accent)' }}>
          Edit notes
        </button>
      </div>
    );
  }

  return (
    <div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        className="w-full px-2 py-1.5 text-xs rounded-md"
        style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
        placeholder="Reconciliation notes, attribution methodology, caveats…"
      />
      <div className="flex gap-2 mt-2 items-center">
        <button onClick={save} disabled={busy} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => setEditing(false)} className="text-xs" style={{ color: 'var(--dt-text-secondary)' }}>Cancel</button>
        {msg && <span className="text-xs" style={{ color: 'var(--dt-text-secondary)' }}>{msg}</span>}
      </div>
    </div>
  );
}
