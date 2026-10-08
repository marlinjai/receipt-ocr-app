'use client';

import { useMemo, useState } from 'react';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { formatGuest } from '@/lib/contacts/store';
import { DISMISSED_HINT, EXCLUSION_LABELS, formatDay, formatEuro, mealActionMessage } from '@/lib/meals/messages';
import { buildRegister, registerYears } from '@/lib/meals/register';
import { MISSING_FIELD_LABELS } from '@/lib/meals/rules';
import type { MealRecord, MealTaxSettings } from '@/lib/meals/types';
import { saveMealTaxSettings } from './actions';
import { ActionNotice, useReceiptActions } from './useReceiptActions';

interface RegisterTabProps {
  records: MealRecord[];
  settings: MealTaxSettings;
  onSettingsChanged: (settings: MealTaxSettings) => void;
  /** Records changed by a list action (now "Keine Bewirtung"). */
  onRecordsSaved: (records: MealRecord[]) => void;
  /** Receipts that no longer exist. */
  onRecordsRemoved: (rowIds: string[]) => void;
  onOpenQueue: () => void;
}

type ExportFormat = 'csv' | 'pdf';

const SECTION_19_QUESTION = 'Ist dieses Unternehmen Kleinunternehmer nach § 19 Umsatzsteuergesetz?';

/** Save a response body as a file download. */
function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function RegisterTab({
  records,
  settings,
  onSettingsChanged,
  onRecordsSaved,
  onRecordsRemoved,
  onOpenQueue,
}: RegisterTabProps) {
  const actions = useReceiptActions({ onRecordsSaved, onRecordsRemoved, dismissedHint: DISMISSED_HINT });
  const years = useMemo(() => {
    const found = registerYears(records);
    return found.length > 0 ? found : [new Date().getFullYear()];
  }, [records]);
  const [year, setYear] = useState(() => years[0]);
  const activeYear = years.includes(year) ? year : years[0];
  const register = useMemo(() => buildRegister(records, settings, activeYear), [records, settings, activeYear]);

  const [settingBusy, setSettingBusy] = useState(false);
  const [settingError, setSettingError] = useState<string | null>(null);
  const [editingSetting, setEditingSetting] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportWarnings, setExportWarnings] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{ format: ExportFormat; count: number } | null>(null);

  const answer = async (smallBusiness: boolean) => {
    if (settingBusy) return;
    setSettingBusy(true);
    setSettingError(null);
    try {
      const result = await saveMealTaxSettings({ smallBusiness });
      if (!result.ok) {
        setSettingError(mealActionMessage(result.error, result.detail));
        return;
      }
      onSettingsChanged(result.value);
      setEditingSetting(false);
    } catch {
      setSettingError(mealActionMessage('failed'));
    } finally {
      setSettingBusy(false);
    }
  };

  /**
   * Fetch the export. A 409 naming incomplete entries is not an error: it
   * opens the confirmation with the count the SERVER reports, and the retry
   * acknowledges exactly that count.
   */
  const runExport = async (format: ExportFormat, acknowledged: number | null) => {
    setExporting(format);
    setExportError(null);
    setExportWarnings([]);
    try {
      const query = new URLSearchParams({ year: String(activeYear), format });
      if (acknowledged !== null) query.set('ack', String(acknowledged));
      const res = await fetch(`/api/meals/register?${query.toString()}`, { cache: 'no-store' });
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; incompleteCount?: number };
        if (body.error === 'incomplete_unacknowledged' && typeof body.incompleteCount === 'number') {
          setConfirm({ format, count: body.incompleteCount });
          return;
        }
        setExportError(`Bitte zuerst die Frage beantworten: ${SECTION_19_QUESTION}`);
        return;
      }
      if (res.status === 401) {
        setExportError(mealActionMessage('unauthorized'));
        return;
      }
      if (!res.ok) {
        setExportError('Der Export ist fehlgeschlagen. Bitte erneut versuchen.');
        return;
      }
      const blob = await res.blob();
      saveBlob(blob, `bewirtungsverzeichnis-${activeYear}.${format}`);
      const header = res.headers.get('X-Register-Warnings');
      if (header) {
        try {
          const warnings = JSON.parse(decodeURIComponent(header)) as unknown;
          if (Array.isArray(warnings)) setExportWarnings(warnings.map(String));
        } catch {
          /* a malformed warnings header must not turn a good download into an error */
        }
      }
    } catch {
      setExportError('Der Export ist fehlgeschlagen: keine Verbindung zum Server. Bitte erneut versuchen.');
    } finally {
      setExporting(null);
    }
  };

  const exportDisabled = register.settingMissing || exporting !== null;
  const net = register.basis === 'net';
  const separate = [
    { label: EXCLUSION_LABELS.staff_meal_internal, ...register.staffMeals },
    { label: EXCLUSION_LABELS.travel_meal, ...register.travelMeals },
    { label: EXCLUSION_LABELS.private, ...register.privateMeals },
  ].filter((s) => s.count > 0);

  return (
    <div className="space-y-5">
      {/* The section 19 question: asked once, changeable here. */}
      {register.settingMissing || editingSetting ? (
        <section className="glass-panel rounded-xl p-5" aria-labelledby="section19-title">
          <h2 id="section19-title" className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
            {SECTION_19_QUESTION}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
            Davon hängt ab, wovon die 70 % berechnet werden. Kleinunternehmer ziehen keine Vorsteuer ab: Grundlage ist
            der Bruttobetrag zuzüglich Trinkgeld. Sonst ist es der Nettobetrag zuzüglich Trinkgeld, die Vorsteuer wird
            gesondert ausgewiesen. Bis zur Antwort zeigt das Verzeichnis keine Beträge, und der Export ist gesperrt.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="ui-btn ui-btn-primary" onClick={() => void answer(true)} disabled={settingBusy}>
              Ja, Kleinunternehmer
            </button>
            <button type="button" className="ui-btn" onClick={() => void answer(false)} disabled={settingBusy}>
              Nein, mit Vorsteuerabzug
            </button>
            {editingSetting && !register.settingMissing && (
              <button type="button" className="ui-btn" onClick={() => setEditingSetting(false)} disabled={settingBusy}>
                Abbrechen
              </button>
            )}
          </div>
          {settingError && (
            <p role="alert" className="ui-note ui-note-danger mt-3">
              {settingError}
            </p>
          )}
        </section>
      ) : (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          {settings.smallBusiness
            ? 'Kleinunternehmer nach § 19 Umsatzsteuergesetz: 70 % vom Bruttobetrag zuzüglich Trinkgeld.'
            : 'Mit Vorsteuerabzug: 70 % vom Nettobetrag zuzüglich Trinkgeld, Vorsteuer gesondert.'}{' '}
          <button type="button" className="underline underline-offset-2" style={{ color: 'var(--accent)' }} onClick={() => setEditingSetting(true)}>
            Ändern
          </button>
        </p>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="block">
          <span className="ui-label">Jahr</span>
          <select className="ui-input" style={{ minWidth: '7rem' }} value={activeYear} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="ui-btn" disabled={exportDisabled} onClick={() => void runExport('csv', null)}>
            {exporting === 'csv' ? 'CSV wird erstellt…' : 'Als CSV exportieren'}
          </button>
          <button type="button" className="ui-btn ui-btn-primary" disabled={exportDisabled} onClick={() => void runExport('pdf', null)}>
            {exporting === 'pdf' ? 'PDF wird erstellt…' : 'Als PDF exportieren'}
          </button>
        </div>
      </div>
      {register.settingMissing && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Der Export ist gesperrt, bis die Frage oben beantwortet ist.
        </p>
      )}
      {exportError && (
        <p role="alert" className="ui-note ui-note-danger">
          {exportError}
        </p>
      )}
      {exportWarnings.length > 0 && (
        <div className="ui-note ui-note-warn" role="status">
          <p className="font-medium">Die Datei wurde erstellt. Hinweise dazu:</p>
          <ul className="mt-1 list-disc pl-5">
            {exportWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {register.incomplete.length > 0 && (
        <div className="ui-note ui-note-warn flex flex-wrap items-center justify-between gap-3">
          <span>
            {register.incomplete.length === 1
              ? `1 Bewirtung aus ${activeYear} ist unvollständig und zählt nicht mit.`
              : `${register.incomplete.length} Bewirtungen aus ${activeYear} sind unvollständig und zählen nicht mit.`}
          </span>
          <button type="button" className="ui-btn ui-btn-sm" onClick={onOpenQueue}>
            Jetzt vervollständigen
          </button>
        </div>
      )}

      <ActionNotice notice={actions.notice} />

      {register.entries.length === 0 ? (
        <div className="glass-panel rounded-xl p-8 text-center text-sm" style={{ color: 'var(--muted)' }}>
          Für {activeYear} gibt es noch keine vollständige Bewirtung.
        </div>
      ) : (
        <div className="glass-panel overflow-x-auto rounded-xl">
          <table className="w-full min-w-[66rem] text-left text-sm">
            <caption className="sr-only">Bewirtungsverzeichnis {activeYear}</caption>
            <thead>
              <tr className="text-xs uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
                <th scope="col" className="px-3 py-2.5 font-medium">Nr.</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Datum</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Ort</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Teilnehmer</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Anlass</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Brutto</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Trinkgeld</th>
                {net && <th scope="col" className="px-3 py-2.5 text-right font-medium">Netto</th>}
                {net && <th scope="col" className="px-3 py-2.5 text-right font-medium">Vorsteuer</th>}
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Abziehbar 70 %</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Nicht abziehbar</th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {register.entries.map(({ no, record, deduction }) => (
                <tr key={record.rowId} className="border-t align-top" style={{ borderColor: 'var(--border-subtle)', color: 'var(--foreground)' }}>
                  <td className="px-3 py-2.5 tabular-nums">{no}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{formatDay(record.date)}</td>
                  <td className="px-3 py-2.5">{record.place}</td>
                  <td className="px-3 py-2.5">{record.guests.map((g) => formatGuest(g.name, g.company)).join(', ')}</td>
                  <td className="px-3 py-2.5">{record.occasion}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{formatEuro(deduction?.gross)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{formatEuro(deduction?.tip)}</td>
                  {net && (
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                      {formatEuro(deduction?.net)}
                      {deduction?.vatEstimated && <span title="Umsatzsteuer geschätzt" style={{ color: 'var(--accent)' }}> *</span>}
                    </td>
                  )}
                  {net && <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{formatEuro(deduction?.inputVat)}</td>}
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-medium tabular-nums">{formatEuro(deduction?.deductible)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{formatEuro(deduction?.nonDeductible)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1.5">
                      {/* A complete entry carries tax weight: taking it out of the register always asks first. */}
                      <button
                        type="button"
                        className="ui-btn ui-btn-sm whitespace-nowrap"
                        disabled={actions.busy}
                        aria-label={`Keine Bewirtung: Nr. ${no}, ${record.place}, ${formatDay(record.date)}`}
                        onClick={() => actions.markNotMeal([record], { confirm: true })}
                      >
                        Keine Bewirtung
                      </button>
                      <button
                        type="button"
                        className="ui-btn ui-btn-sm ui-btn-danger"
                        disabled={actions.busy}
                        aria-label={`Löschen: Nr. ${no}, ${record.place}, ${formatDay(record.date)}`}
                        onClick={() => actions.requestDelete([record])}
                      >
                        Löschen
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            {register.totals && (
              <tfoot>
                <tr className="border-t font-semibold" style={{ borderColor: 'var(--border)', color: 'var(--foreground)' }}>
                  <th scope="row" colSpan={5} className="px-3 py-3 text-left">Summe</th>
                  <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{formatEuro(register.totals.gross)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{formatEuro(register.totals.tip)}</td>
                  {net && <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{formatEuro(register.totals.net)}</td>}
                  {net && <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{formatEuro(register.totals.inputVat)}</td>}
                  <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums" style={{ color: 'var(--accent)' }}>{formatEuro(register.totals.deductible)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{formatEuro(register.totals.nonDeductible)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {register.totals && register.entries.length > 0 && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Abziehbar auf Konto 4650, nicht abziehbar auf Konto 4654. Alle Beträge in Euro.
          {register.vatEstimatedCount > 0 && ` * Umsatzsteuer geschätzt bei ${register.vatEstimatedCount} Einträgen (keine Steuerzeilen erfasst).`}
          {register.vatMismatchCount > 0 && ` Bei ${register.vatMismatchCount} Einträgen ergeben die Steuerzeilen nicht den Rechnungsbetrag.`}
        </p>
      )}

      {register.incomplete.length > 0 && (
        <section aria-labelledby="incomplete-title">
          <h2 id="incomplete-title" className="mb-2 text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
            Unvollständig, nicht in den Summen
          </h2>
          <ul className="space-y-1.5">
            {register.incomplete.map(({ record, missing }) => (
              <li key={record.rowId} className="ui-note flex flex-wrap justify-between gap-2">
                <span>
                  {formatDay(record.date)} · {record.vendor || record.name || 'Beleg'}
                </span>
                <span style={{ color: 'var(--muted)' }}>fehlt: {missing.map((m) => MISSING_FIELD_LABELS[m]).join(', ')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {separate.length > 0 && (
        <section aria-labelledby="separate-title">
          <h2 id="separate-title" className="mb-2 text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
            Gesondert gezählt, nicht im Verzeichnis
          </h2>
          <ul className="flex flex-wrap gap-2">
            {separate.map((s) => (
              <li key={s.label} className="ui-note">
                {s.label}: {s.count} ({formatEuro(s.grossEur)})
              </li>
            ))}
          </ul>
        </section>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title="Mit unvollständigen Einträgen exportieren?"
        confirmLabel="Trotzdem exportieren"
        cancelLabel="Zurück"
        busy={exporting !== null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const pending = confirm;
          setConfirm(null);
          if (pending) void runExport(pending.format, pending.count);
        }}
      >
        {confirm && (
          <p>
            {confirm.count === 1
              ? `1 Bewirtung aus ${activeYear} ist unvollständig.`
              : `${confirm.count} Bewirtungen aus ${activeYear} sind unvollständig.`}{' '}
            Unvollständige Einträge werden in der Datei gesondert aufgeführt und zählen nicht in die Summen. Abziehbar
            sind sie erst, wenn Teilnehmer und Anlass erfasst sind.
          </p>
        )}
      </ConfirmDialog>
      {actions.dialogs}
    </div>
  );
}
