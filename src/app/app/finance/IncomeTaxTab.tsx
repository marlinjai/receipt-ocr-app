'use client';

import { useId, useState } from 'react';
import type { Figure, IncomeTaxEstimate, TaxBalance } from '@/lib/tax/income-tax/estimate';
import { RETURN_ITEM_KEYS, RETURN_ITEM_KINDS, type ReturnItemFact, type ReturnItemKey } from '@/lib/tax/income-tax/return-items';
import { FEDERAL_STATES, FEDERAL_STATE_LABELS, type FederalState } from '@/lib/tax/income-tax/rules';
import type { WageEntry, WageFigures } from '@/lib/tax/income-tax/wages';
import { formatDay } from '@/lib/meals/messages';
import { formatCents } from '@/lib/tax/money';
import { berlinDay } from '@/lib/tax/year-boundary';
import type { StatementView } from '@/lib/tax/service';
import { MONTHS, euro, parseEuro } from './amounts';
import ScrollBox from '@/components/ui/ScrollBox';

export type WageDraft = WageFigures & {
  year: number;
  employer: string;
  month: number;
  healthWithSickPay: boolean;
  churchLiable: boolean | null;
};

export interface ReturnItemDraft {
  year: number;
  key: ReturnItemKey;
  amountCents: number | null;
  days: number | null;
  distanceKm: number | null;
  ownCar: boolean;
  note: string | null;
}

interface Props {
  view: StatementView;
  busy: boolean;
  error: string | null;
  onSaveWage: (wageId: string | null, draft: WageDraft, done: () => void) => void;
  onRemoveWage: (entry: WageEntry) => void;
  onSaveItem: (itemId: string | null, draft: ReturnItemDraft, done: () => void) => void;
  onRemoveItem: (item: ReturnItemFact) => void;
  onChurchMonths: (months: boolean[] | null) => void;
  onFederalState: (state: FederalState | null) => void;
  /** The day the return of the year was filed (ISO), or null: the year is open again. */
  onFiledOn: (filedOn: string | null) => void;
}

/** "Erstattung 4.249,76 €" or "Nachzahlung 120,00 €": a sign is easy to misread on a tax figure. */
export function balanceText(cents: number): string {
  if (cents === 0) return 'ausgeglichen (0,00 €)';
  return cents < 0 ? `Erstattung ${euro(-cents)}` : `Nachzahlung ${euro(cents)}`;
}

const SCOPE_LABEL: Record<IncomeTaxEstimate['scope'], string> = {
  full: 'Lohn und Gewerbe',
  business_only: 'nur Gewerbe',
  without_business: 'ohne Gewerbe',
  none: 'keine Angaben',
};

const WAGE_FIELD_LABELS: Array<[keyof WageFigures, string]> = [
  ['grossCents', 'Bruttoarbeitslohn'],
  ['wageTaxCents', 'Lohnsteuer'],
  ['solidarityCents', 'Solidaritätszuschlag'],
  ['churchTaxCents', 'Kirchensteuer'],
  ['pensionEmployeeCents', 'Rentenversicherung Arbeitnehmer'],
  ['pensionEmployerCents', 'Rentenversicherung Arbeitgeber'],
  ['healthEmployeeCents', 'Krankenversicherung Arbeitnehmer'],
  ['careEmployeeCents', 'Pflegeversicherung Arbeitnehmer'],
  ['unemploymentEmployeeCents', 'Arbeitslosenversicherung Arbeitnehmer'],
];

const monthLabel = (month: number) => (month === 0 ? 'Lohnsteuerbescheinigung' : MONTHS[month - 1]);

function TaxRow({ label, balance }: { label: string; balance: TaxBalance }) {
  return (
    <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
      <th scope="row" className="py-1 text-left font-normal">{label}</th>
      <td className="py-1 text-right">{balance.assessedCents === null ? 'offen' : euro(balance.assessedCents)}</td>
      <td className="py-1 text-right">{euro(balance.withheldCents + balance.prepaidCents)}</td>
      <td className="py-1 text-right">{balance.balanceCents === null ? 'offen' : balanceText(balance.balanceCents)}</td>
    </tr>
  );
}

function FigureLine({ figure }: { figure: Figure }) {
  const hasDetail = figure.inputs.length > 0 || figure.source || figure.note;
  const amount = (
    <span className="shrink-0 tabular-nums" style={{ color: 'var(--foreground)' }}>
      {euro(figure.cents)}
    </span>
  );
  if (!hasDetail) {
    return (
      <li className="flex items-baseline justify-between gap-3 py-1 text-sm">
        <span>{figure.label}</span>
        {amount}
      </li>
    );
  }
  return (
    <li className="py-1 text-sm">
      <details>
        <summary className="flex cursor-pointer items-baseline justify-between gap-3">
          <span>{figure.label}</span>
          {amount}
        </summary>
        <div className="mt-1 space-y-1 pl-4 text-xs" style={{ color: 'var(--muted)' }}>
          {figure.inputs.map((input, i) => (
            <p key={`${figure.id}-${i}`} className="flex justify-between gap-3">
              <span>{input.label}</span>
              <span className="tabular-nums">{input.text ?? (input.cents === null ? '' : euro(input.cents))}</span>
            </p>
          ))}
          {figure.note && <p>{figure.note}</p>}
          {figure.source && (
            <p>
              Quelle:{' '}
              <a href={figure.source.url} className="underline" target="_blank" rel="noreferrer">
                {figure.source.citation}
              </a>{' '}
              (geprüft am {figure.source.checkedOn})
            </p>
          )}
        </div>
      </details>
    </li>
  );
}

function emptyWage(employer: string, month: number): Record<keyof WageFigures, string> & { employer: string; month: number; sickPay: boolean; church: '' | 'yes' | 'no' } {
  return {
    employer,
    month,
    sickPay: true,
    church: '',
    ...(Object.fromEntries(WAGE_FIELD_LABELS.map(([k]) => [k, ''])) as Record<keyof WageFigures, string>),
  };
}

/**
 * The income tax estimate of the year and the facts it needs: wages (annual
 * statement or monthly pay slips), church tax months and federal state, and
 * the other items of the return. Every figure opens to its inputs and source.
 */
export default function IncomeTaxTab({ view, busy, error, onSaveWage, onRemoveWage, onSaveItem, onRemoveItem, onChurchMonths, onFederalState, onFiledOn }: Props) {
  const id = useId();
  const tax = view.incomeTax;
  const [showProjected, setShowProjected] = useState(true);
  const estimate = showProjected && tax.projected ? tax.projected : tax.estimate;
  const lastEmployer = tax.wageEntries[tax.wageEntries.length - 1]?.employer ?? '';
  const nextMonth = Math.min(12, Math.max(0, ...tax.wageEntries.map((w) => w.month)) + 1);
  const [wageEditing, setWageEditing] = useState<string | 'new' | null>(null);
  const [wage, setWage] = useState(() => emptyWage(lastEmployer, nextMonth));
  const [itemEditing, setItemEditing] = useState<string | 'new' | null>(null);
  const [itemKey, setItemKey] = useState<ReturnItemKey>('employment.home_office_days');
  const [itemAmount, setItemAmount] = useState('');
  const [itemDays, setItemDays] = useState('');
  const [itemKm, setItemKm] = useState('');
  const [itemOwnCar, setItemOwnCar] = useState(false);
  const [itemNote, setItemNote] = useState('');
  // The checkboxes follow what is stored: after a save, a cleared statement or a
  // new pay slip they show what the estimate now uses, not what was clicked before.
  const storedMonths = tax.churchMonths ?? tax.churchMonthsFromPaySlips ?? Array.from({ length: 12 }, () => false);
  const storedMonthsKey = storedMonths.map((m) => (m ? '1' : '0')).join('');
  const [months, setMonths] = useState<boolean[]>(storedMonths);
  const [seenMonthsKey, setSeenMonthsKey] = useState(storedMonthsKey);
  if (storedMonthsKey !== seenMonthsKey) {
    setSeenMonthsKey(storedMonthsKey);
    setMonths(storedMonths);
  }
  // The filing day follows what is stored, like the months above.
  const [filedOn, setFiledOn] = useState(tax.filedOn ?? '');
  const [seenFiledOn, setSeenFiledOn] = useState(tax.filedOn);
  if (tax.filedOn !== seenFiledOn) {
    setSeenFiledOn(tax.filedOn);
    setFiledOn(tax.filedOn ?? '');
  }
  const [localError, setLocalError] = useState<string | null>(null);
  const shown = localError ?? error;

  const submitFiledOn = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(filedOn)) return setLocalError('Bitte das Abgabedatum als gültiges Datum eingeben.');
    setLocalError(null);
    onFiledOn(filedOn);
  };

  const startWage = (entry: WageEntry | null) => {
    setLocalError(null);
    if (entry === null) {
      setWage(emptyWage(lastEmployer, nextMonth));
      setWageEditing('new');
      return;
    }
    setWage({
      employer: entry.employer,
      month: entry.month,
      sickPay: entry.healthWithSickPay,
      church: entry.churchLiable === null ? '' : entry.churchLiable ? 'yes' : 'no',
      ...(Object.fromEntries(WAGE_FIELD_LABELS.map(([k]) => [k, entry[k] ? formatCents(entry[k]) : ''])) as Record<keyof WageFigures, string>),
    });
    setWageEditing(entry.id);
  };

  const submitWage = () => {
    const figures = {} as WageFigures;
    for (const [k, label] of WAGE_FIELD_LABELS) {
      const text = wage[k];
      const cents = text.trim() === '' ? 0 : parseEuro(text);
      if (cents === null) return setLocalError(`${label}: bitte einen Betrag wie 1.234,56 eingeben.`);
      figures[k] = cents;
    }
    if (!wage.employer.trim()) return setLocalError('Bitte eine Bezeichnung für den Arbeitgeber eingeben.');
    setLocalError(null);
    onSaveWage(
      wageEditing === 'new' ? null : wageEditing,
      {
        year: view.year,
        employer: wage.employer.trim(),
        month: wage.month,
        healthWithSickPay: wage.sickPay,
        churchLiable: wage.month === 0 || wage.church === '' ? null : wage.church === 'yes',
        ...figures,
      },
      () => setWageEditing(null),
    );
  };

  const startItem = (item: ReturnItemFact | null) => {
    setLocalError(null);
    setItemEditing(item ? item.id : 'new');
    setItemKey(item?.key ?? 'employment.home_office_days');
    setItemAmount(item?.amountCents ? formatCents(item.amountCents) : '');
    setItemDays(item?.days ? String(item.days) : '');
    setItemKm(item?.distanceKm ? String(item.distanceKm) : '');
    setItemOwnCar(item?.ownCar ?? false);
    setItemNote(item?.note ?? '');
  };

  const submitItem = () => {
    const measure = RETURN_ITEM_KINDS[itemKey].measure;
    let amountCents: number | null = null;
    let days: number | null = null;
    let distanceKm: number | null = null;
    if (measure === 'amount') {
      amountCents = parseEuro(itemAmount);
      if (amountCents === null || amountCents <= 0) return setLocalError('Bitte einen Betrag wie 777,66 eingeben.');
    } else {
      days = /^\d+$/.test(itemDays.trim()) ? Number(itemDays.trim()) : null;
      if (days === null || days <= 0) return setLocalError('Bitte die Zahl der Tage eingeben.');
      if (measure === 'commute') {
        distanceKm = /^\d+$/.test(itemKm.trim()) ? Number(itemKm.trim()) : null;
        if (distanceKm === null || distanceKm <= 0) return setLocalError('Bitte die einfache Entfernung in vollen Kilometern eingeben.');
      }
    }
    setLocalError(null);
    onSaveItem(itemEditing === 'new' ? null : itemEditing, { year: view.year, key: itemKey, amountCents, days, distanceKm, ownCar: measure === 'commute' && itemOwnCar, note: itemNote.trim() || null }, () => setItemEditing(null));
  };

  const total = estimate.totalBalanceCents;
  const sectionTitle = (s: string) => (
    <h3 className="mt-4 text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
      {s}
    </h3>
  );

  return (
    <div className="space-y-6">
      <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Einkommensteuer-Schätzung">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
            Einkommensteuer {view.year}: Schätzung ({SCOPE_LABEL[estimate.scope]})
          </h2>
          {tax.projected && (
            <div className="ui-seg" role="group" aria-label="Lohn hochrechnen">
              <button type="button" aria-pressed={showProjected} onClick={() => setShowProjected(true)}>
                Lohn bis Dezember hochgerechnet
              </button>
              <button type="button" aria-pressed={!showProjected} onClick={() => setShowProjected(false)}>
                Nur erfasste Monate
              </button>
            </div>
          )}
        </div>
        {estimate.scope === 'none' ? (
          <p className="ui-note mt-3">
            Für {view.year} gibt es weder Lohndaten noch ein Ergebnis des Gewerbes. Trag unten eine Lohnabrechnung oder
            die Lohnsteuerbescheinigung ein; das Gewerbe kommt aus der Einnahmenüberschussrechnung (EÜR), sobald Rechnungen erfasst sind.
          </p>
        ) : (
          <>
            <p className="mt-3 text-2xl font-semibold tabular-nums" style={{ color: 'var(--foreground)' }}>
              {total === null ? `${balanceText(estimate.totalWithoutChurchCents)} ohne Kirchensteuer` : balanceText(total)}
            </p>
            <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
              Eine Schätzung, kein Bescheid. {tax.running ? 'Stand heute: das Gewerbe mit dem Ergebnis bis heute. ' : ''}
              Zu versteuerndes Einkommen {euro(estimate.taxableIncomeEuros * 100)}.
            </p>
            {estimate.businessEffectCents !== null && (
              <p className="mt-1 text-sm" style={{ color: 'var(--foreground)' }}>
                Was das Gewerbe an deiner Steuer ändert:{' '}
                {estimate.businessEffectCents < 0
                  ? `${euro(-estimate.businessEffectCents)} weniger`
                  : `${euro(estimate.businessEffectCents)} mehr`}
              </p>
            )}
            <ScrollBox className="ui-table-scroll" label={`Steuern ${view.year}`}>
            <table className="mt-3 w-full text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>
              <caption className="sr-only">Steuern {view.year}</caption>
              <thead>
                <tr className="text-left text-xs" style={{ color: 'var(--muted)' }}>
                  <th scope="col" className="py-1 font-medium">Steuer</th>
                  <th scope="col" className="py-1 text-right font-medium">festzusetzen</th>
                  <th scope="col" className="py-1 text-right font-medium">einbehalten und vorausgezahlt</th>
                  <th scope="col" className="py-1 text-right font-medium">Ergebnis</th>
                </tr>
              </thead>
              <tbody>
                <TaxRow label="Einkommensteuer" balance={estimate.incomeTax} />
                <TaxRow label="Solidaritätszuschlag" balance={estimate.solidarity} />
                <TaxRow label="Kirchensteuer" balance={estimate.churchTax} />
              </tbody>
            </table>
            </ScrollBox>
          </>
        )}
        <div className="mt-3 space-y-2">
          {!estimate.rulesExact && (
            <p className="ui-note ui-note-warn">
              Für {view.year} sind noch keine eigenen Steuerwerte hinterlegt (Tarif, Freibeträge). Gerechnet wird mit denen von {estimate.rulesYear}.
            </p>
          )}
          {estimate.missing.map((m) => (
            <p key={m.code + m.text} className="ui-note ui-note-warn">
              {m.text}
            </p>
          ))}
          {estimate.assumptions.map((a) => (
            <p key={a} className="ui-note">
              {a}
            </p>
          ))}
        </div>
        {estimate.scope !== 'none' && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium" style={{ color: 'var(--foreground)' }}>
              Rechenweg mit Quellen
            </summary>
            {estimate.sections.map((s) => (
              <div key={s.id}>
                {sectionTitle(s.title)}
                <ul className="mt-1" style={{ color: 'var(--muted)' }}>
                  {s.figures.map((f) => (
                    <FigureLine key={f.id} figure={f} />
                  ))}
                </ul>
              </div>
            ))}
            <ul className="mt-4 list-disc space-y-1 pl-5 text-xs" style={{ color: 'var(--muted)' }}>
              {estimate.notCovered.map((n) => (
                <li key={n}>{n}</li>
              ))}
              <li>Steuerwerte zuletzt durchgesehen am {estimate.rulesReviewedOn}.</li>
            </ul>
          </details>
        )}
      </section>

      <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Lohn">
        <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
          Lohn {view.year}
        </h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Die Lohnsteuerbescheinigung gilt, sobald sie da ist. Bis dahin zählen die monatlichen Lohnabrechnungen; im
          laufenden Jahr kann die letzte bis Dezember hochgerechnet werden.
        </p>
        {tax.wageEntries.length > 0 && (
          <ScrollBox className="ui-table-scroll" label={`Lohnangaben ${view.year}`}>
          <table className="mt-3 w-full text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>
            <caption className="sr-only">Lohnangaben {view.year}</caption>
            <thead>
              <tr className="text-left text-xs" style={{ color: 'var(--muted)' }}>
                <th scope="col" className="py-1 font-medium">Arbeitgeber und Zeitraum</th>
                <th scope="col" className="py-1 text-right font-medium">Brutto</th>
                <th scope="col" className="py-1 text-right font-medium">Lohnsteuer</th>
                <th scope="col" className="py-1 text-right font-medium">Kirchensteuer</th>
                <th scope="col" className="py-1">
                  <span className="sr-only">Aktionen</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tax.wageEntries.map((w) => (
                <tr key={w.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <th scope="row" className="py-1 text-left font-normal">
                    {w.employer}: {monthLabel(w.month)}
                  </th>
                  <td className="py-1 text-right">{euro(w.grossCents)}</td>
                  <td className="py-1 text-right">{euro(w.wageTaxCents)}</td>
                  <td className="py-1 text-right">{euro(w.churchTaxCents)}</td>
                  <td className="py-1 text-right">
                    <span className="inline-flex gap-1">
                      <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => startWage(w)}>
                        Ändern
                      </button>
                      <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" disabled={busy} onClick={() => onRemoveWage(w)}>
                        Löschen
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </ScrollBox>
        )}
        {wageEditing === null ? (
          <button type="button" className="ui-btn ui-btn-primary mt-3" onClick={() => startWage(null)}>
            Lohnabrechnung oder Bescheinigung eintragen
          </button>
        ) : (
          <form
            className="mt-3 space-y-3"
            aria-label="Lohnangabe"
            onSubmit={(e) => {
              e.preventDefault();
              submitWage();
            }}
          >
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="ui-label" htmlFor={`${id}-employer`}>
                  Arbeitgeber
                </label>
                <input id={`${id}-employer`} className="ui-input" value={wage.employer} maxLength={60} onChange={(e) => setWage({ ...wage, employer: e.target.value })} />
              </div>
              <div>
                <label className="ui-label" htmlFor={`${id}-month`}>
                  Zeitraum
                </label>
                <select id={`${id}-month`} className="ui-input" style={{ width: 'auto' }} value={wage.month} onChange={(e) => setWage({ ...wage, month: Number(e.target.value) })}>
                  <option value={0}>Lohnsteuerbescheinigung (ganzes Jahr)</option>
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>
                      Lohnabrechnung {m}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {WAGE_FIELD_LABELS.map(([k, label]) => (
                <div key={k}>
                  <label className="ui-label" htmlFor={`${id}-${k}`}>
                    {label} in €
                  </label>
                  <input id={`${id}-${k}`} className="ui-input tabular-nums" inputMode="decimal" value={wage[k]} onChange={(e) => setWage({ ...wage, [k]: e.target.value })} />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm" style={{ color: 'var(--foreground)' }}>
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={wage.sickPay} onChange={(e) => setWage({ ...wage, sickPay: e.target.checked })} />
                Krankenversicherung mit Anspruch auf Krankengeld
              </label>
              {wage.month > 0 && (
                <label className="inline-flex items-center gap-2">
                  Kirchensteuerpflichtig in diesem Monat
                  <select className="ui-input" style={{ width: 'auto' }} value={wage.church} onChange={(e) => setWage({ ...wage, church: e.target.value as '' | 'yes' | 'no' })}>
                    <option value="">aus der Kirchensteuer ablesen</option>
                    <option value="yes">ja</option>
                    <option value="no">nein</option>
                  </select>
                </label>
              )}
            </div>
            <div className="flex gap-2">
              <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>
                Speichern
              </button>
              <button type="button" className="ui-btn" onClick={() => setWageEditing(null)}>
                Abbrechen
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Kirchensteuer">
        <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
          Kirchensteuer {view.year}
        </h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="ui-label" htmlFor={`${id}-state`}>
              Bundesland (für den Kirchensteuersatz)
            </label>
            <select
              id={`${id}-state`}
              className="ui-input"
              style={{ width: 'auto' }}
              value={tax.federalState ?? ''}
              disabled={busy}
              onChange={(e) => onFederalState(e.target.value ? (e.target.value as FederalState) : null)}
            >
              <option value="">nicht angegeben</option>
              {FEDERAL_STATES.map((s) => (
                <option key={s} value={s}>
                  {FEDERAL_STATE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <fieldset className="mt-3">
          <legend className="ui-label">Monate mit Kirchensteuerpflicht</legend>
          <div className="mt-1 flex flex-wrap gap-2 text-sm" style={{ color: 'var(--foreground)' }}>
            {MONTHS.map((m, i) => (
              <label key={m} className="inline-flex items-center gap-1">
                <input type="checkbox" checked={months[i]} onChange={(e) => setMonths(months.map((v, j) => (j === i ? e.target.checked : v)))} />
                {m}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
          {tax.churchMonths
            ? 'Angegeben für dieses Jahr.'
            : tax.churchMonthsFromPaySlips
              ? 'Noch nicht angegeben; vorbelegt aus den Lohnabrechnungen.'
              : 'Noch nicht angegeben.'}{' '}
          Nach einem Kirchenaustritt endet die Pflicht mit dem Monat des Austritts.
        </p>
        <div className="mt-2 flex gap-2">
          <button type="button" className="ui-btn" disabled={busy} onClick={() => onChurchMonths(months)}>
            Monate speichern
          </button>
          {tax.churchMonths && (
            <button type="button" className="ui-btn" disabled={busy} onClick={() => onChurchMonths(null)}>
              Angabe entfernen
            </button>
          )}
        </div>
      </section>

      <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Abgabe der Erklärung">
        <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
          Abgabe der Erklärung {view.year}
        </h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--foreground)' }}>
          {tax.filedOn ? `Abgegeben am ${formatDay(tax.filedOn)}.` : 'Noch nicht als abgegeben eingetragen.'}
        </p>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Ein abgegebenes Jahr legt die Zahlungen um seinen Jahreswechsel so fest, wie sie erklärt wurden: jede bleibt in dem
          Jahr, in dem sie bezahlt wurde. Eine später gegebene Antwort, die eine Zahlung über das abgegebene Jahr verschieben
          würde, wird nicht angewendet, sondern im Tab „Jahreswechsel“ angezeigt.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="ui-label" htmlFor={`${id}-filed`}>
              Erklärung {view.year} abgegeben am
            </label>
            <input
              id={`${id}-filed`}
              type="date"
              className="ui-input"
              style={{ width: 'auto' }}
              value={filedOn}
              min={`${view.year + 1}-01-01`}
              max={berlinDay()}
              disabled={busy}
              onChange={(e) => setFiledOn(e.target.value)}
            />
          </div>
          <button type="button" className="ui-btn" disabled={busy || filedOn === '' || filedOn === tax.filedOn} onClick={submitFiledOn}>
            Abgabedatum speichern
          </button>
          {tax.filedOn && (
            <button type="button" className="ui-btn" disabled={busy} onClick={() => onFiledOn(null)}>
              Abgabedatum entfernen
            </button>
          )}
        </div>
      </section>

      <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Weitere Angaben">
        <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
          Weitere Angaben zur Steuererklärung {view.year}
        </h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Belege mit Anteil Studium oder Anstellung zählen schon über die Anlage N (Einkünfte aus nichtselbständiger Arbeit) der Ansicht „EÜR“ ({euro(view.employmentCostCents)}).
        </p>
        {tax.returnItems.length > 0 && (
          <ul className="mt-3 space-y-1.5 text-sm" style={{ color: 'var(--foreground)' }}>
            {tax.returnItems.map((item) => (
              <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  {RETURN_ITEM_KINDS[item.key].label}:{' '}
                  {item.amountCents !== null
                    ? euro(item.amountCents)
                    : `${item.days} Tage${item.distanceKm !== null ? ` × ${item.distanceKm} km${item.ownCar ? ', eigener oder überlassener Wagen' : ''}` : ''}`}
                  {item.note ? ` (${item.note})` : ''}
                </span>
                <span className="inline-flex gap-1">
                  <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => startItem(item)}>
                    Ändern
                  </button>
                  <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" disabled={busy} onClick={() => onRemoveItem(item)}>
                    Löschen
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {itemEditing === null ? (
          <button type="button" className="ui-btn mt-3" onClick={() => startItem(null)}>
            Angabe hinzufügen
          </button>
        ) : (
          <form
            className="mt-3 flex flex-wrap items-end gap-3"
            aria-label="Weitere Angabe"
            onSubmit={(e) => {
              e.preventDefault();
              submitItem();
            }}
          >
            <div>
              <label className="ui-label" htmlFor={`${id}-key`}>
                Art
              </label>
              <select id={`${id}-key`} className="ui-input" style={{ width: 'auto' }} value={itemKey} onChange={(e) => setItemKey(e.target.value as ReturnItemKey)}>
                {RETURN_ITEM_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {RETURN_ITEM_KINDS[k].label}
                  </option>
                ))}
              </select>
            </div>
            {RETURN_ITEM_KINDS[itemKey].measure === 'amount' ? (
              <div>
                <label className="ui-label" htmlFor={`${id}-amount`}>
                  Betrag in €
                </label>
                <input id={`${id}-amount`} className="ui-input tabular-nums" inputMode="decimal" value={itemAmount} onChange={(e) => setItemAmount(e.target.value)} />
              </div>
            ) : (
              <div>
                <label className="ui-label" htmlFor={`${id}-days`}>
                  Tage
                </label>
                <input id={`${id}-days`} className="ui-input tabular-nums" inputMode="numeric" value={itemDays} onChange={(e) => setItemDays(e.target.value)} />
              </div>
            )}
            {RETURN_ITEM_KINDS[itemKey].measure === 'commute' && (
              <div>
                <label className="ui-label" htmlFor={`${id}-km`}>
                  Entfernung in km
                </label>
                <input id={`${id}-km`} className="ui-input tabular-nums" inputMode="numeric" value={itemKm} onChange={(e) => setItemKm(e.target.value)} />
              </div>
            )}
            {RETURN_ITEM_KINDS[itemKey].measure === 'commute' && (
              <label className="inline-flex items-center gap-2 text-sm" style={{ color: 'var(--foreground)' }}>
                <input type="checkbox" checked={itemOwnCar} onChange={(e) => setItemOwnCar(e.target.checked)} />
                mit eigenem oder überlassenem Wagen (auch Firmenwagen)
              </label>
            )}
            <div className="min-w-[12rem] flex-1">
              <label className="ui-label" htmlFor={`${id}-note`}>
                Notiz (Beleg, Zeitraum)
              </label>
              <input id={`${id}-note`} className="ui-input" maxLength={200} value={itemNote} onChange={(e) => setItemNote(e.target.value)} />
            </div>
            <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>
              Speichern
            </button>
            <button type="button" className="ui-btn" onClick={() => setItemEditing(null)}>
              Abbrechen
            </button>
            <p className="w-full text-xs" style={{ color: 'var(--muted)' }}>
              {RETURN_ITEM_KINDS[itemKey].hint}
            </p>
          </form>
        )}
      </section>

      {shown && (
        <p className="ui-note ui-note-danger" role="alert">
          {shown}
        </p>
      )}
    </div>
  );
}
