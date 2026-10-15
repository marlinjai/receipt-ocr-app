'use client';

import { useId, useState } from 'react';
import type { StatementItem } from '@/lib/tax/service';

export interface ReverseChargeSubmit {
  /** 1900 or 700; null: "not under section 13b". */
  rateBp: number | null;
  applyToVendor?: { vendor: string; effectiveFrom?: string };
}

interface Props {
  item: StatementItem;
  busy: boolean;
  onSubmit: (submit: ReverseChargeSubmit) => void;
  /** Remove the receipt's own statement; null when it has none. */
  onReset: (() => void) | null;
}

type Choice = 'none' | '1900' | '700';

const ORIGIN_TEXT = { item: 'an diesem Beleg', vendor_rule: 'Regel für den Lieferanten' } as const;

/**
 * Whether the buyer owes the tax on this purchase (section 13b of the
 * value-added tax act): a service from a supplier abroad whose invoice shows
 * no German tax. Stated per receipt, or for the vendor from a day on.
 */
export default function ReverseChargeForm({ item, busy, onSubmit, onReset }: Props) {
  const id = useId();
  const current: Choice = item.reverseCharge ? (String(item.reverseCharge.rateBp) as Choice) : 'none';
  const [choice, setChoice] = useState<Choice>(current);
  const [forVendor, setForVendor] = useState(false);
  const [from, setFrom] = useState('');
  // Saving the choice the receipt already has, for itself only, would change nothing.
  const unchanged = choice === current && !forVendor;

  return (
    <form
      className="mt-3 space-y-2 border-t pt-3"
      style={{ borderColor: 'var(--border)' }}
      onSubmit={(e) => {
        e.preventDefault();
        const rateBp = choice === 'none' ? null : Number(choice);
        onSubmit(forVendor && item.vendor ? { rateBp, applyToVendor: { vendor: item.vendor, effectiveFrom: from } } : { rateBp });
      }}
    >
      <fieldset>
        <legend className="ui-label">Steuerschuldnerschaft des Leistungsempfängers (§ 13b Umsatzsteuergesetz)</legend>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Für sonstige Leistungen (keine Waren) eines Anbieters aus dem Ausland, deren Leistungsort in Deutschland liegt und
          deren Rechnung keine deutsche Umsatzsteuer ausweist, schuldet der Betrieb die Steuer selbst, auch als
          Kleinunternehmer: zum Beispiel Software, Cloud-Dienste, Werbung, Beratung. Nicht für Hotel, Bewirtung oder Fahrten
          im Ausland; Waren aus einem anderen EU-Staat sind ein innergemeinschaftlicher Erwerb (§ 1a), kein § 13b.
          {item.reverseCharge ? ` Derzeit: ${item.reverseCharge.rateBp / 100} % (${ORIGIN_TEXT[item.reverseCharge.origin]}).` : ''}
          {item.lineId ? ' Die Angabe gilt für den ganzen Beleg.' : ''}
        </p>
        {item.currency !== 'EUR' && (
          <p className="ui-note ui-note-warn mt-1 text-xs">
            Dieser Beleg lautet auf {item.currency}. Gerechnet wird mit dem gebuchten Euro-Betrag; für die Umsatzsteuer gilt
            der monatliche Durchschnittskurs des Bundesfinanzministeriums, sofern das Finanzamt nicht den Tageskurs gestattet
            hat (§ 16 Absatz 6 Umsatzsteuergesetz).
          </p>
        )}
        <div className="ui-seg mt-1" role="group" aria-label="§ 13b">
          <button type="button" aria-pressed={choice === 'none'} onClick={() => setChoice('none')}>kein § 13b</button>
          <button type="button" aria-pressed={choice === '1900'} onClick={() => setChoice('1900')}>19 %</button>
          <button type="button" aria-pressed={choice === '700'} onClick={() => setChoice('700')}>7 %</button>
        </div>
      </fieldset>
      {item.vendor && (
        <div className="flex flex-wrap items-end gap-2 text-sm" style={{ color: 'var(--foreground)' }}>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={forVendor} onChange={(e) => setForVendor(e.target.checked)} />
            § 13b für alle Belege von {item.vendor}
          </label>
          {forVendor && (
            <div>
              <label className="ui-label" htmlFor={`${id}-from`}>gilt ab (leer: von Anfang an)</label>
              <input id={`${id}-from`} type="date" className="ui-input" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="ui-btn ui-btn-sm" disabled={busy || unchanged}>§ 13b speichern</button>
        {onReset && (
          <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={onReset}>
            Angabe am Beleg entfernen
          </button>
        )}
      </div>
    </form>
  );
}
