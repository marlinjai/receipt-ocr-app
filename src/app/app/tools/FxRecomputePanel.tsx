'use client';

import { useState } from 'react';
import { recomputeFxRates } from '../actions';

/**
 * Manual "recompute FX for date range" batch action (Open Question 3 from the
 * vendor-invoice-aggregation plan) — for invoices backfilled after the fact, where
 * the live lookup in processReceipt wasn't available yet at upload time.
 */
export default function FxRecomputePanel() {
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
      setError(err instanceof Error ? err.message : 'Die Kurse konnten nicht neu berechnet werden.');
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div>
      <p className="text-sm mb-3" style={{ color: 'var(--dt-text-secondary)' }}>
      Holt für jeden Beleg in fremder Währung aus diesem Zeitraum den Kurs der Europäischen Zentralbank neu. Nützlich, wenn Belege nachgetragen wurden, für die beim Hochladen kein Kurs verfügbar war.
    </p>
    <div className="grid gap-2 mb-3 sm:grid-cols-2">
      <label className="text-xs" style={{ color: 'var(--dt-text-secondary)' }}>
        Von
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="mt-1 w-full px-2 py-1.5 text-sm rounded-md"
          style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
        />
      </label>
      <label className="text-xs" style={{ color: 'var(--dt-text-secondary)' }}>
        Bis
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
      className="ui-btn ui-btn-primary"
    >
      {isRunning ? 'Berechnet …' : 'Wechselkurse neu berechnen'}
    </button>
    {result && (
      <p className="text-xs mt-2" style={{ color: 'var(--dt-text-secondary)' }}>
        Aktualisiert: {result.updated}, fehlgeschlagen: {result.failed}, in Euro übersprungen: {result.skippedEur}.
      </p>
    )}
    {error && (
      <p className="text-xs mt-2" role="alert" style={{ color: '#f87171' }}>
        {error}
      </p>
    )}
    </div>
  );
}
