'use client';

import { useId, useState } from 'react';
import { formatCents, shareOf } from '@/lib/tax/money';
import { PURPOSE_LABELS } from '@/lib/tax/messages';
import type { FormLine, FormLineKey } from '@/lib/tax/rules/types';
import type { StatementItem } from '@/lib/tax/service';
import type { Allocation } from '@/lib/tax/types';

export interface TreatmentDraft {
  allocations: Allocation[];
  formLineKey: FormLineKey | null;
  employmentLineKey: FormLineKey | null;
  severalLowValueItems: boolean;
}

export interface TreatmentSubmit {
  treatment: TreatmentDraft;
  applyToVendor: { vendor: string; effectiveFrom?: string } | null;
}

interface Props {
  item: StatementItem;
  formLines: FormLine[];
  busy: boolean;
  error: string | null;
  submitLabel: string;
  onSubmit: (submit: TreatmentSubmit) => void;
}

type Shares = { business: string; study: string; employment: string };

const PRESETS: Array<{ label: string; shares: Shares }> = [
  { label: '100 % Betrieb', shares: { business: '100', study: '', employment: '' } },
  { label: '50 % Betrieb', shares: { business: '50', study: '', employment: '' } },
  { label: '50 % Betrieb, 30 % Studium', shares: { business: '50', study: '30', employment: '' } },
  { label: '100 % Studium', shares: { business: '', study: '100', employment: '' } },
  { label: 'Privat', shares: { business: '', study: '', employment: '' } },
];

function initialShares(item: StatementItem): Shares {
  const of = (purpose: Allocation['purpose']) => {
    const bp = item.allocations?.find((a) => a.purpose === purpose)?.shareBp ?? 0;
    return bp > 0 ? String(bp / 100) : '';
  };
  return { business: of('business'), study: of('study'), employment: of('employment') };
}

/** A typed percentage to basis points; null when it is not a number from 0 to 100. */
function toBp(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100);
}

/**
 * Who bears an item and which form lines it goes to. The form only collects
 * the decision; the figures on the page come back from the server after the
 * save, computed by the tax module. The preview below the shares uses the same
 * `shareOf` so it cannot show a different rounding.
 */
export default function TreatmentForm({ item, formLines, busy, error, submitLabel, onSubmit }: Props) {
  const id = useId();
  const [shares, setShares] = useState<Shares>(() => initialShares(item));
  const [formLineKey, setFormLineKey] = useState<string>(item.formLineKey && item.formLineKey !== 'euer.meals' ? item.formLineKey : '');
  const [employmentLineKey, setEmploymentLineKey] = useState<string>(item.employmentLineKey ?? '');
  const [several, setSeveral] = useState(item.severalLowValueItems);
  const [forVendor, setForVendor] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const bp = { business: toBp(shares.business), study: toBp(shares.study), employment: toBp(shares.employment) };
  const valid = bp.business !== null && bp.study !== null && bp.employment !== null;
  const total = valid ? (bp.business as number) + (bp.study as number) + (bp.employment as number) : 0;
  const privateBp = Math.max(0, 10000 - total);
  const needsFormLine = (bp.business ?? 0) > 0;
  const needsEmploymentLine = (bp.study ?? 0) + (bp.employment ?? 0) > 0;

  const euerLines = formLines.filter((l) => l.form === 'euer' && l.kind === 'expense' && l.key !== 'euer.meals' && !l.assetOnly && !l.computedOnly);
  const employmentLines = formLines.filter((l) => l.form === 'employment');

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) return setLocalError('Bitte Anteile als Zahl zwischen 0 und 100 eingeben.');
    if (total > 10000) return setLocalError('Die Anteile ergeben zusammen mehr als 100 %.');
    if (needsFormLine && !formLineKey) return setLocalError('Für den betrieblichen Anteil bitte eine Zeile der EÜR wählen.');
    if (needsEmploymentLine && !employmentLineKey) {
      return setLocalError('Für den Anteil Studium oder Anstellung bitte eine Zeile der Anlage N wählen.');
    }
    setLocalError(null);
    const allocations: Allocation[] = [];
    if ((bp.business as number) > 0) allocations.push({ purpose: 'business', shareBp: bp.business as number });
    if ((bp.study as number) > 0) allocations.push({ purpose: 'study', shareBp: bp.study as number });
    if ((bp.employment as number) > 0) allocations.push({ purpose: 'employment', shareBp: bp.employment as number });
    // Nothing deducted anywhere is a decision too: the item is private.
    if (allocations.length === 0) allocations.push({ purpose: 'private', shareBp: 10000 });
    onSubmit({
      treatment: {
        allocations,
        formLineKey: needsFormLine ? (formLineKey as FormLineKey) : null,
        employmentLineKey: needsEmploymentLine ? (employmentLineKey as FormLineKey) : null,
        severalLowValueItems: needsFormLine && formLineKey === 'euer.low_value_assets' && item.lineId === null && several,
      },
      applyToVendor: forVendor && item.vendor ? { vendor: item.vendor, effectiveFrom: effectiveFrom || undefined } : null,
    });
  }

  const shown = localError ?? error;
  const preview = (shareBp: number | null) =>
    item.amountCents !== null && shareBp !== null && shareBp <= 10000 ? `${formatCents(shareOf(item.amountCents, shareBp))} €` : '';

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <fieldset>
        <legend className="ui-label">Wer trägt die Kosten?</legend>
        <div className="ui-seg mb-3" role="group" aria-label="Häufige Aufteilungen">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              aria-pressed={
                shares.business === preset.shares.business &&
                shares.study === preset.shares.study &&
                shares.employment === preset.shares.employment
              }
              onClick={() => setShares(preset.shares)}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {(['business', 'study', 'employment'] as const).map((purpose) => (
            <div key={purpose}>
              <label className="ui-label" htmlFor={`${id}-${purpose}`}>
                {PURPOSE_LABELS[purpose]} in %
              </label>
              <input
                id={`${id}-${purpose}`}
                className="ui-input tabular-nums"
                inputMode="decimal"
                value={shares[purpose]}
                aria-invalid={bp[purpose] === null}
                onChange={(e) => setShares((s) => ({ ...s, [purpose]: e.target.value }))}
                placeholder="0"
              />
              <p className="mt-1 text-xs tabular-nums" style={{ color: 'var(--muted)' }}>
                {preview(bp[purpose])}
              </p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs" style={{ color: total > 10000 ? 'var(--danger)' : 'var(--muted)' }} role="status">
          {total > 10000
            ? `Zusammen ${total / 100} %: mehr als der ganze Beleg.`
            : `Privat bleibt ${privateBp / 100} %${item.amountCents !== null ? ` (${preview(privateBp)})` : ''}.`}
        </p>
      </fieldset>

      {needsFormLine && (
        <div>
          <label className="ui-label" htmlFor={`${id}-line`}>
            Zeile der EÜR für den betrieblichen Anteil
          </label>
          <select id={`${id}-line`} className="ui-input" value={formLineKey} onChange={(e) => setFormLineKey(e.target.value)}>
            <option value="">Bitte wählen</option>
            {euerLines.map((l) => (
              <option key={l.key} value={l.key}>
                {l.line !== null ? `${l.line} · ` : ''}
                {l.label}
              </option>
            ))}
          </select>
          {/* A line is one position; several items are said by splitting further. */}
          {formLineKey === 'euer.low_value_assets' && item.lineId === null && (
            <label className="mt-2 flex items-start gap-2 text-sm" style={{ color: 'var(--foreground)' }}>
              <input type="checkbox" className="mt-1" checked={several} onChange={(e) => setSeveral(e.target.checked)} />
              <span>
                Der Beleg enthält mehrere Wirtschaftsgüter, jedes für sich unter der Grenze
                <span className="block text-xs" style={{ color: 'var(--muted)' }}>
                  Dann darf die Summe über der Grenze liegen. Ein einzelnes Wirtschaftsgut über der Grenze wird als
                  Anlage geführt.
                </span>
              </span>
            </label>
          )}
        </div>
      )}

      {needsEmploymentLine && (
        <div>
          <label className="ui-label" htmlFor={`${id}-annex`}>
            Zeile der Anlage N für Studium oder Anstellung
          </label>
          <select id={`${id}-annex`} className="ui-input" value={employmentLineKey} onChange={(e) => setEmploymentLineKey(e.target.value)}>
            <option value="">Bitte wählen</option>
            {employmentLines.map((l) => (
              <option key={l.key} value={l.key}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* A line is one position of one receipt: it says nothing about the vendor as a whole. */}
      {item.vendor && item.vendorKey && item.lineId === null && (
        <div className="ui-note">
          <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--foreground)' }}>
            <input type="checkbox" className="mt-1" checked={forVendor} onChange={(e) => setForVendor(e.target.checked)} />
            <span>
              Für alle Belege von <strong>{item.vendor}</strong> so behandeln
              <span className="block text-xs" style={{ color: 'var(--muted)' }}>
                Belege, für die einzeln etwas anderes entschieden wurde, behalten ihre Entscheidung.
              </span>
            </span>
          </label>
          {forVendor && (
            <div className="mt-3 max-w-xs">
              <label className="ui-label" htmlFor={`${id}-from`}>
                Gilt ab (leer: von Anfang an)
              </label>
              <input id={`${id}-from`} type="date" className="ui-input" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
            </div>
          )}
        </div>
      )}

      {shown && (
        <p className="ui-note ui-note-danger" role="alert">
          {shown}
        </p>
      )}

      <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>
        {busy ? 'Speichert …' : submitLabel}
      </button>
    </form>
  );
}
