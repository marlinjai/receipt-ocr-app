'use client';

import { useId, useState } from 'react';
import { formatDay } from '@/lib/meals/messages';
import type { AssetKind, AssetMethod, DisposalKind } from '@/lib/tax/assets';
import { ASSET_CHECK_LABELS, ASSET_METHOD_LABELS, DISPOSAL_LABELS } from '@/lib/tax/messages';
import { eurosToCents, formatCents } from '@/lib/tax/money';
import type { AssetView, StatementItem, StatementView } from '@/lib/tax/service';

export interface AssetDraft {
  label: string;
  kind: AssetKind;
  acquisitionDate: string | null;
  method: AssetMethod;
  usefulLifeMonths: number | null;
  decliningRateBp: number | null;
  businessShareBp: number;
  reminderCents: number;
  opening: { year: number; bookValueCents: number; remainingMonths: number } | null;
  rowIds: string[];
}

export interface DisposalDraft {
  date: string;
  kind: DisposalKind;
  proceedsCents: number;
}

interface Props {
  view: StatementView;
  busy: boolean;
  error: string | null;
  /** A receipt to start a new asset from (set when coming from the queue). */
  startFromRowId: string | null;
  onStartHandled: () => void;
  onSave: (assetId: string | null, draft: AssetDraft, done: () => void) => void;
  onDelete: (asset: AssetView) => void;
  onDispose: (asset: AssetView, disposal: DisposalDraft | null, done: () => void) => void;
}

const euro = (cents: number) => `${formatCents(cents)} €`;

/** A typed euro amount ("1.234,56" or "1234.56") to cents; null when it is not an amount. */
function parseEuro(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const normalized = trimmed.includes(',') ? trimmed.replace(/\./g, '').replace(',', '.') : trimmed;
  const n = Number(normalized);
  return Number.isFinite(n) && n >= 0 ? eurosToCents(n) : null;
}

function parseNumber(text: string): number | null {
  const n = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(n) ? n : null;
}

/**
 * The asset register of the year: what each asset cost, how it is written off,
 * what it is worth at the start and end of the year. The cost is never typed
 * in: it is the sum of the receipts ticked for the asset.
 */
export default function AssetsTab({ view, busy, error, startFromRowId, onStartHandled, onSave, onDelete, onDispose }: Props) {
  const [editing, setEditing] = useState<string | 'new' | null>(startFromRowId ? 'new' : null);
  const [disposing, setDisposing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const close = () => {
    setEditing(null);
    onStartHandled();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Anlageverzeichnis {view.year}. Sofort abziehbar bis {euro(view.assetLimits.lowValueNetLimitCents)} netto je
          Wirtschaftsgut; darüber wird über die Nutzungsdauer abgeschrieben.
        </p>
        {editing !== 'new' && (
          <button type="button" className="ui-btn ui-btn-primary" onClick={() => setEditing('new')}>
            Neue Anlage
          </button>
        )}
      </div>

      {editing === 'new' && (
        <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Neue Anlage">
          <h2 className="mb-3 text-base font-semibold" style={{ color: 'var(--foreground)' }}>
            Neue Anlage
          </h2>
          <AssetForm view={view} asset={null} startFromRowId={startFromRowId} busy={busy} error={error} onCancel={close} onSubmit={(draft) => onSave(null, draft, close)} />
        </section>
      )}

      {view.assets.length === 0 && editing !== 'new' ? (
        <div className="glass-panel rounded-xl p-8 text-center text-sm" style={{ color: 'var(--muted)' }}>
          Für {view.year} ist keine Anlage erfasst. Eine Anlage entsteht aus einem oder mehreren Belegen (Kauf,
          Versand, Einfuhrabgaben) oder wird mit ihrem Buchwert aus früheren Jahren übernommen.
        </div>
      ) : (
        <ul className="space-y-3">
          {view.assets.map((asset) => {
            const open = expanded === asset.id;
            return (
              <li key={asset.id} className="glass-panel rounded-xl p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <div>
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
                      {asset.label}
                    </h3>
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                      {asset.opening
                        ? `übernommen zum 01.01.${asset.opening.year}`
                        : `angeschafft ${formatDay(asset.acquisitionDate)}`}
                      {asset.costCents !== null ? ` · Anschaffungskosten ${euro(asset.costCents)}` : ''}
                      {' · '}
                      {ASSET_METHOD_LABELS[asset.method]}
                      {asset.usefulLifeMonths ? ` (${asset.usefulLifeMonths} Monate)` : ''}
                      {asset.businessShareBp < 10000 ? ` · ${asset.businessShareBp / 100} % betrieblich` : ''}
                      {asset.disposal ? ` · ${DISPOSAL_LABELS[asset.disposal.kind]} am ${formatDay(asset.disposal.date)}` : ''}
                    </p>
                  </div>
                  {asset.row && (
                    <dl className="flex gap-5 text-right text-xs" style={{ color: 'var(--muted)' }}>
                      <div>
                        <dt>Buchwert 01.01.</dt>
                        <dd className="text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>{euro(asset.row.bookValueStartCents)}</dd>
                      </div>
                      <div>
                        <dt>Abschreibung {view.year}</dt>
                        <dd className="text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>{euro(asset.row.depreciationCents)}</dd>
                      </div>
                      <div>
                        <dt>Buchwert 31.12.</dt>
                        <dd className="text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>{euro(asset.row.bookValueEndCents)}</dd>
                      </div>
                    </dl>
                  )}
                </div>

                {asset.checks.length > 0 && (
                  <p className="ui-note ui-note-warn mt-3" role="status">
                    Diese Anlage wird noch nicht gerechnet: {asset.checks.map((c) => ASSET_CHECK_LABELS[c.kind]).join('; ')}.
                  </p>
                )}
                {asset.counted && !asset.row && (
                  <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
                    In {view.year} nicht mehr im Verzeichnis (bereits abgegangen).
                  </p>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className="ui-btn ui-btn-sm" aria-expanded={editing === asset.id} onClick={() => setEditing(editing === asset.id ? null : asset.id)}>
                    {editing === asset.id ? 'Schließen' : 'Ändern'}
                  </button>
                  {asset.schedule.length > 0 && (
                    <button type="button" className="ui-btn ui-btn-sm" aria-expanded={open} onClick={() => setExpanded(open ? null : asset.id)}>
                      {open ? 'Verlauf ausblenden' : 'Verlauf'}
                    </button>
                  )}
                  {asset.disposal ? (
                    <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onDispose(asset, null, () => undefined)}>
                      Abgang zurücknehmen
                    </button>
                  ) : (
                    <button type="button" className="ui-btn ui-btn-sm" aria-expanded={disposing === asset.id} onClick={() => setDisposing(disposing === asset.id ? null : asset.id)}>
                      Abgang erfassen
                    </button>
                  )}
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm ui-btn-danger"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`Anlage „${asset.label}“ löschen? Ihre Belege werden wieder als gewöhnliche Belege behandelt.`)) return;
                      onDelete(asset);
                    }}
                  >
                    Löschen
                  </button>
                </div>

                {open && (
                  <table className="mt-3 w-full text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>
                    <caption className="sr-only">Abschreibungsverlauf {asset.label}</caption>
                    <thead>
                      <tr className="text-left text-xs" style={{ color: 'var(--muted)' }}>
                        <th scope="col" className="py-1 font-medium">Jahr</th>
                        <th scope="col" className="py-1 text-right font-medium">Buchwert 01.01.</th>
                        <th scope="col" className="py-1 text-right font-medium">Zugang</th>
                        <th scope="col" className="py-1 text-right font-medium">Abschreibung</th>
                        <th scope="col" className="py-1 text-right font-medium">Abgang</th>
                        <th scope="col" className="py-1 text-right font-medium">Buchwert 31.12.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {asset.schedule.map((row) => (
                        <tr key={row.year} className="border-t" style={{ borderColor: 'var(--border)' }}>
                          <th scope="row" className="py-1 text-left font-normal">{row.year}</th>
                          <td className="py-1 text-right">{euro(row.bookValueStartCents)}</td>
                          <td className="py-1 text-right">{euro(row.additionCents)}</td>
                          <td className="py-1 text-right">{euro(row.depreciationCents)}</td>
                          <td className="py-1 text-right">{euro(row.disposalBookValueCents)}</td>
                          <td className="py-1 text-right">{euro(row.bookValueEndCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {editing === asset.id && (
                  <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                    <AssetForm view={view} asset={asset} startFromRowId={null} busy={busy} error={error} onCancel={() => setEditing(null)} onSubmit={(draft) => onSave(asset.id, draft, () => setEditing(null))} />
                  </div>
                )}
                {disposing === asset.id && !asset.disposal && (
                  <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                    <DisposalForm busy={busy} error={error} onCancel={() => setDisposing(null)} onSubmit={(d) => onDispose(asset, d, () => setDisposing(null))} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function candidateReceipts(view: StatementView, asset: AssetView | null): StatementItem[] {
  return view.items.filter((i) => !i.isMeal && (i.assetId === null || i.assetId === asset?.id));
}

function AssetForm({
  view,
  asset,
  startFromRowId,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  view: StatementView;
  asset: AssetView | null;
  startFromRowId: string | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (draft: AssetDraft) => void;
}) {
  const id = useId();
  const candidates = candidateReceipts(view, asset);
  const start = startFromRowId ? view.items.find((i) => i.rowId === startFromRowId) ?? null : null;
  // Receipts of the asset that are not among this year's receipts stay linked untouched.
  const hiddenRowIds = (asset?.rowIds ?? []).filter((r) => !candidates.some((c) => c.rowId === r));

  const [label, setLabel] = useState(asset?.label ?? start?.label ?? '');
  const [kind, setKind] = useState<AssetKind>(asset?.kind ?? 'movable');
  const [carried, setCarried] = useState(asset ? asset.opening !== null : false);
  const [date, setDate] = useState(asset?.acquisitionDate ?? start?.date ?? '');
  const [method, setMethod] = useState<AssetMethod>(asset?.method ?? 'linear');
  const [years, setYears] = useState(asset?.usefulLifeMonths ? String(asset.usefulLifeMonths / 12).replace('.', ',') : '');
  const [rate, setRate] = useState(asset?.decliningRateBp ? String(asset.decliningRateBp / 100).replace('.', ',') : String(view.assetLimits.decliningMaxRateBp / 100));
  const [share, setShare] = useState(String((asset?.businessShareBp ?? 10000) / 100).replace('.', ','));
  const [reminder, setReminder] = useState((asset?.reminderCents ?? 0) > 0);
  const [selected, setSelected] = useState<string[]>(() => (asset ? asset.rowIds.filter((r) => candidates.some((c) => c.rowId === r)) : start ? [start.rowId] : []));
  const [openingYear, setOpeningYear] = useState(String(asset?.opening?.year ?? view.year));
  const [openingValue, setOpeningValue] = useState(asset?.opening ? formatCents(asset.opening.bookValueCents) : '');
  const [openingMonths, setOpeningMonths] = useState(String(asset?.opening?.remainingMonths ?? 0));
  const [localError, setLocalError] = useState<string | null>(null);

  const selectedItems = candidates.filter((c) => selected.includes(c.rowId));
  const cost = selectedItems.every((i) => i.amountCents !== null) ? selectedItems.reduce((s, i) => s + (i.amountCents as number), 0) : null;
  const needsLife = !carried && (method === 'linear' || method === 'declining');
  const limits = view.assetLimits;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!label.trim()) return setLocalError('Bitte eine Bezeichnung für die Anlage eingeben.');
    const shareNumber = parseNumber(share);
    if (shareNumber === null || shareNumber < 1 || shareNumber > 100) return setLocalError('Der betriebliche Anteil muss zwischen 1 und 100 % liegen.');

    let opening: AssetDraft['opening'] = null;
    let usefulLifeMonths: number | null = null;
    let decliningRateBp: number | null = null;
    if (carried) {
      const y = parseNumber(openingYear);
      const value = parseEuro(openingValue);
      const months = parseNumber(openingMonths);
      if (y === null || !Number.isInteger(y) || value === null || months === null || !Number.isInteger(months) || months < 0) {
        return setLocalError('Bitte Jahr, Buchwert und Restnutzungsdauer der übernommenen Anlage prüfen.');
      }
      opening = { year: y, bookValueCents: value, remainingMonths: months };
    } else {
      if (!date) return setLocalError('Bitte ein gültiges Anschaffungsdatum eingeben.');
      if (selected.length + hiddenRowIds.length === 0) {
        return setLocalError('Bitte mindestens einen Beleg zuordnen: die Anschaffungskosten sind die Summe der Belege.');
      }
      if (needsLife) {
        const y = parseNumber(years);
        const months = y === null ? null : Math.round(y * 12);
        if (months === null || months <= 12) return setLocalError('Bitte eine Nutzungsdauer von mehr als einem Jahr eingeben.');
        usefulLifeMonths = months;
      }
      if (method === 'declining') {
        const r = parseNumber(rate);
        if (r === null || r <= 0 || r > 100) return setLocalError('Bitte den Satz der degressiven Abschreibung in Prozent eingeben.');
        decliningRateBp = Math.round(r * 100);
      }
    }
    setLocalError(null);
    onSubmit({
      label: label.trim(),
      kind,
      acquisitionDate: carried ? null : date,
      method: carried ? 'linear' : method,
      usefulLifeMonths,
      decliningRateBp,
      businessShareBp: Math.round(shareNumber * 100),
      reminderCents: reminder ? 100 : 0,
      opening,
      rowIds: carried ? [] : [...hiddenRowIds, ...selected],
    });
  }

  const shown = localError ?? error;
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="ui-label" htmlFor={`${id}-label`}>Bezeichnung</label>
          <input id={`${id}-label`} className="ui-input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} />
        </div>
        <div>
          <span className="ui-label" id={`${id}-kind`}>Art</span>
          <div className="ui-seg" role="group" aria-labelledby={`${id}-kind`}>
            <button type="button" aria-pressed={kind === 'movable'} onClick={() => setKind('movable')}>Bewegliches Wirtschaftsgut</button>
            <button type="button" aria-pressed={kind === 'intangible'} onClick={() => setKind('intangible')}>Software, immateriell</button>
          </div>
        </div>
      </div>

      <div>
        <span className="ui-label" id={`${id}-origin`}>Herkunft</span>
        <div className="ui-seg" role="group" aria-labelledby={`${id}-origin`}>
          <button type="button" aria-pressed={!carried} onClick={() => setCarried(false)}>Angeschafft, aus Belegen</button>
          <button type="button" aria-pressed={carried} onClick={() => setCarried(true)}>Aus früheren Jahren übernommen</button>
        </div>
      </div>

      {carried ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="ui-label" htmlFor={`${id}-oy`}>Buchwert zum 1. Januar des Jahres</label>
            <input id={`${id}-oy`} className="ui-input tabular-nums" inputMode="numeric" value={openingYear} onChange={(e) => setOpeningYear(e.target.value)} />
          </div>
          <div>
            <label className="ui-label" htmlFor={`${id}-ov`}>Buchwert in €</label>
            <input id={`${id}-ov`} className="ui-input tabular-nums" inputMode="decimal" value={openingValue} onChange={(e) => setOpeningValue(e.target.value)} placeholder="1,00" />
          </div>
          <div>
            <label className="ui-label" htmlFor={`${id}-om`}>Restnutzungsdauer in Monaten</label>
            <input id={`${id}-om`} className="ui-input tabular-nums" inputMode="numeric" value={openingMonths} onChange={(e) => setOpeningMonths(e.target.value)} />
          </div>
        </div>
      ) : (
        <>
          <fieldset>
            <legend className="ui-label">Belege, aus denen sich die Anschaffungskosten ergeben</legend>
            {candidates.length === 0 ? (
              <p className="ui-note">Für {view.year} gibt es keinen freien Beleg. Bitte den Kaufbeleg zuerst hochladen.</p>
            ) : (
              <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-2" style={{ borderColor: 'var(--border)' }}>
                {candidates.map((c) => (
                  <li key={c.rowId}>
                    <label className="flex items-baseline gap-2 text-sm" style={{ color: 'var(--foreground)' }}>
                      <input
                        type="checkbox"
                        checked={selected.includes(c.rowId)}
                        onChange={(e) => setSelected((list) => (e.target.checked ? [...list, c.rowId] : list.filter((r) => r !== c.rowId)))}
                      />
                      <span className="flex-1">
                        {c.vendor || c.label}
                        <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>{formatDay(c.date)}</span>
                      </span>
                      <span className="tabular-nums">{c.amountCents !== null ? euro(c.amountCents) : 'ohne Betrag'}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }} role="status">
              {hiddenRowIds.length > 0 ? `${hiddenRowIds.length} weitere Belege aus anderen Jahren bleiben zugeordnet. ` : ''}
              {selected.length === 0
                ? 'Noch kein Beleg gewählt.'
                : cost === null
                  ? 'Ein gewählter Beleg hat keinen Betrag; die Kosten sind damit unbekannt.'
                  : `Anschaffungskosten aus ${selected.length === 1 ? '1 Beleg' : `${selected.length} Belegen`}: ${euro(cost)} (brutto, ohne Vorsteuerabzug).`}
            </p>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="ui-label" htmlFor={`${id}-date`}>Anschaffungsdatum (Lieferung)</label>
              <input id={`${id}-date`} type="date" className="ui-input" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label className="ui-label" htmlFor={`${id}-method`}>Abschreibung</label>
              <select id={`${id}-method`} className="ui-input" value={method} onChange={(e) => setMethod(e.target.value as AssetMethod)}>
                {(Object.keys(ASSET_METHOD_LABELS) as AssetMethod[]).map((m) => (
                  <option key={m} value={m}>{ASSET_METHOD_LABELS[m]}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="ui-note">
            {method === 'low_value' && `Nur bis ${euro(limits.lowValueNetLimitCents)} netto je Wirtschaftsgut. Die Grenze wird am Nettobetrag geprüft, abgezogen wird der Bruttobetrag.`}
            {method === 'pool' && `Für Wirtschaftsgüter über ${euro(limits.poolMinExclusiveNetCents)} bis ${euro(limits.poolMaxNetCents)} netto. Aufgelöst über ${limits.poolYears} Jahre, auch wenn das Wirtschaftsgut vorher ausscheidet.`}
            {method === 'linear' && 'Gleiche Beträge über die Nutzungsdauer, im ersten Jahr ab dem Monat der Anschaffung. Die Nutzungsdauer steht in den amtlichen AfA-Tabellen.'}
            {method === 'computer_one_year' && 'Für Computerhardware und Software lässt die Finanzverwaltung eine Nutzungsdauer von einem Jahr zu; die Kosten werden im Jahr der Anschaffung voll abgezogen.'}
            {method === 'declining' && `Nur für bewegliche Wirtschaftsgüter, angeschafft vom ${formatDay(limits.decliningFrom)} bis ${formatDay(limits.decliningTo)}. Höchstens ${limits.decliningMaxRateBp / 100} % und höchstens das ${limits.decliningMaxMultiple}-fache des linearen Satzes.`}
          </p>
          {needsLife && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="ui-label" htmlFor={`${id}-years`}>Nutzungsdauer in Jahren</label>
                <input id={`${id}-years`} className="ui-input tabular-nums" inputMode="decimal" value={years} onChange={(e) => setYears(e.target.value)} placeholder="z. B. 7" />
              </div>
              {method === 'declining' && (
                <div>
                  <label className="ui-label" htmlFor={`${id}-rate`}>Satz in % vom Restwert</label>
                  <input id={`${id}-rate`} className="ui-input tabular-nums" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="ui-label" htmlFor={`${id}-share`}>Betrieblicher Anteil in %</label>
          <input id={`${id}-share`} className="ui-input tabular-nums" inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 self-end pb-2 text-sm" style={{ color: 'var(--foreground)' }}>
          <input type="checkbox" checked={reminder} onChange={(e) => setReminder(e.target.checked)} />
          Erinnerungswert von 1 € stehen lassen
        </label>
      </div>

      {shown && <p className="ui-note ui-note-danger" role="alert">{shown}</p>}
      <div className="flex gap-2">
        <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>{busy ? 'Speichert …' : asset ? 'Anlage speichern' : 'Anlage anlegen'}</button>
        <button type="button" className="ui-btn" onClick={onCancel}>Abbrechen</button>
      </div>
    </form>
  );
}

function DisposalForm({ busy, error, onCancel, onSubmit }: { busy: boolean; error: string | null; onCancel: () => void; onSubmit: (d: DisposalDraft) => void }) {
  const id = useId();
  const [date, setDate] = useState('');
  const [kind, setKind] = useState<DisposalKind>('sold');
  const [proceeds, setProceeds] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!date) return setLocalError('Bitte das Datum des Abgangs eingeben.');
    const cents = kind === 'scrapped' ? 0 : parseEuro(proceeds);
    if (cents === null) return setLocalError(kind === 'sold' ? 'Bitte den Verkaufserlös eingeben.' : 'Bitte den Wert bei der Übernahme ins Privatvermögen eingeben.');
    setLocalError(null);
    onSubmit({ date, kind, proceedsCents: cents });
  }

  const shown = localError ?? error;
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div className="ui-seg" role="group" aria-label="Art des Abgangs">
        {(Object.keys(DISPOSAL_LABELS) as DisposalKind[]).map((k) => (
          <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{DISPOSAL_LABELS[k]}</button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="ui-label" htmlFor={`${id}-date`}>Datum des Abgangs</label>
          <input id={`${id}-date`} type="date" className="ui-input" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        {kind !== 'scrapped' && (
          <div>
            <label className="ui-label" htmlFor={`${id}-proceeds`}>{kind === 'sold' ? 'Verkaufserlös in €' : 'Wert bei der Übernahme in €'}</label>
            <input id={`${id}-proceeds`} className="ui-input tabular-nums" inputMode="decimal" value={proceeds} onChange={(e) => setProceeds(e.target.value)} />
          </div>
        )}
      </div>
      {kind === 'private' && (
        <p className="ui-note ui-note-warn">
          Die Übernahme ins Privatvermögen wird wie ein Verkauf zum angegebenen Wert behandelt. Welcher Wert anzusetzen
          ist, sollte ein Steuerberater bestätigen.
        </p>
      )}
      {shown && <p className="ui-note ui-note-danger" role="alert">{shown}</p>}
      <div className="flex gap-2">
        <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>{busy ? 'Speichert …' : 'Abgang speichern'}</button>
        <button type="button" className="ui-btn" onClick={onCancel}>Abbrechen</button>
      </div>
    </form>
  );
}
