'use client';

import { useState } from 'react';
import { recomputeFxRates } from '../actions';

/**
 * Manual "recompute FX for date range" batch action (Open Question 3 from the
 * vendor-invoice-aggregation plan) — for invoices backfilled after the fact, where
 * the live lookup in processReceipt wasn't available yet at upload time.
 */
export default function FxRecomputePanel() {
  const [open, setOpen] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<{ updated: number; failed: number; skippedEur: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRecompute = async () => {
    if (!startDate || !endDate) return;
    setIsRunning(true);
    setError(null);
    setResult(null);
    try {
      const outcome = await recomputeFxRates(startDate, endDate);
      setResult(outcome);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recompute failed');
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200"
        style={{
          background: open ? 'var(--accent-muted)' : 'var(--surface)',
          color: open ? 'var(--accent)' : 'var(--foreground)',
          border: `1px solid ${open ? 'rgba(226, 163, 72, 0.4)' : 'var(--border)'}`,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M23 4v6h-6M1 20v-6h6" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
        Recompute FX
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 z-20 w-72 rounded-lg p-4 shadow-xl"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          <p className="text-xs mb-3" style={{ color: 'var(--dt-text-secondary)' }}>
            Refetch the historical ECB rate for every non-EUR invoice dated in this range. Useful after
            backfilling invoices whose FX lookup wasn&apos;t available at upload time.
          </p>
          <div className="flex flex-col gap-2 mb-3">
            <label className="text-xs" style={{ color: 'var(--dt-text-secondary)' }}>
              Start date
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-1 w-full px-2 py-1.5 text-sm rounded-md"
                style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              />
            </label>
            <label className="text-xs" style={{ color: 'var(--dt-text-secondary)' }}>
              End date
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="mt-1 w-full px-2 py-1.5 text-sm rounded-md"
                style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              />
            </label>
          </div>
          <button
            onClick={handleRecompute}
            disabled={!startDate || !endDate || isRunning}
            className="w-full px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRunning ? 'Recomputing...' : 'Recompute'}
          </button>
          {result && (
            <p className="text-xs mt-2" style={{ color: 'var(--dt-text-secondary)' }}>
              Updated {result.updated}, failed {result.failed}, skipped {result.skippedEur} EUR rows.
            </p>
          )}
          {error && (
            <p className="text-xs mt-2" style={{ color: '#f87171' }}>
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
