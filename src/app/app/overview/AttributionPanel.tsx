'use client';

import { useState } from 'react';
import type { VendorShare } from '@/lib/overview/attribution';

const inputStyle = { background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)' } as const;

/**
 * Workspace attribution editor: per-vendor share % + a default, with "save" and
 * "save & apply to ledger" (which writes the shares onto each matching row's
 * Business Share %, so the ledger and the attributed totals stay in sync).
 */
export default function AttributionPanel({
  initialRules,
  initialDefault,
}: {
  initialRules: VendorShare[];
  initialDefault: number;
}) {
  const [rules, setRules] = useState<VendorShare[]>(initialRules.length ? initialRules : [{ vendor: '', share: 100 }]);
  const [defaultShare, setDefaultShare] = useState(initialDefault);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const setRule = (i: number, patch: Partial<VendorShare>) =>
    setRules((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const save = async (apply: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/overview/attribution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: rules.filter((r) => r.vendor.trim()), defaultShare, apply }),
      });
      if (!res.ok) {
        setMsg('Save failed');
        return;
      }
      const data = await res.json();
      if (apply) {
        setMsg(`Applied to ${data.applied} rows — refreshing…`);
        window.location.reload();
      } else {
        setMsg('Saved.');
      }
    } catch {
      setMsg('Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="text-xs mb-2" style={{ color: 'var(--dt-text-secondary)' }}>
        Per-vendor attribution %. A vendor name matches any invoice vendor containing it (e.g. “Anthropic”
        covers “Anthropic (Claude)”). Apply writes these onto the ledger’s Business Share %.
      </p>
      <div className="flex flex-col gap-1.5 mb-2">
        {rules.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              value={r.vendor}
              onChange={(e) => setRule(i, { vendor: e.target.value })}
              placeholder="Vendor keyword"
              className="flex-1 px-2 py-1 text-xs rounded-md"
              style={inputStyle}
            />
            <input
              type="number"
              min={0}
              max={100}
              value={r.share}
              onChange={(e) => setRule(i, { share: Number(e.target.value) })}
              className="w-16 px-2 py-1 text-xs rounded-md"
              style={inputStyle}
            />
            <span className="text-xs" style={{ color: 'var(--dt-text-secondary)' }}>%</span>
            <button
              onClick={() => setRules((rs) => rs.filter((_, idx) => idx !== i))}
              className="text-xs px-1.5"
              style={{ color: '#f87171' }}
              aria-label="Remove"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={() => setRules((rs) => [...rs, { vendor: '', share: 100 }])}
        className="text-xs mb-3"
        style={{ color: 'var(--accent)' }}
      >
        + Add vendor
      </button>

      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs" style={{ color: 'var(--foreground)' }}>Default (unlisted vendors)</span>
        <input
          type="number"
          min={0}
          max={100}
          value={defaultShare}
          onChange={(e) => setDefaultShare(Number(e.target.value))}
          className="w-16 px-2 py-1 text-xs rounded-md"
          style={inputStyle}
        />
        <span className="text-xs" style={{ color: 'var(--dt-text-secondary)' }}>%</span>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => save(false)}
          disabled={busy}
          className="px-3 py-1.5 text-sm rounded-md hover:opacity-90 disabled:opacity-50"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
        >
          Save
        </button>
        <button
          onClick={() => save(true)}
          disabled={busy}
          className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'Applying…' : 'Save & apply to ledger'}
        </button>
      </div>
      {msg && <p className="text-xs mt-2" style={{ color: 'var(--dt-text-secondary)' }}>{msg}</p>}
    </div>
  );
}
