'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { formatGuest, type Contact } from '@/lib/contacts/store';
import {
  DISMISSED_HINT,
  EXCLUSION_LABELS,
  formatDay,
  formatEuro,
  mealActionMessage,
  missingList,
  missingSummary,
  registerEditNotice,
} from '@/lib/meals/messages';
import { buildRegister, registerYearChoices, undatedMeals } from '@/lib/meals/register';
import type { MealRecord, MealTaxSettings } from '@/lib/meals/types';
import { saveMealTaxSettings } from './actions';
import MealEditor from './MealEditor';
import { useReceiptActions } from './useReceiptActions';

interface RegisterTabProps {
  records: MealRecord[];
  /** The guest picker of the editor offers these. */
  contacts: Contact[];
  settings: MealTaxSettings;
  defaultHost: string;
  onSettingsChanged: (settings: MealTaxSettings) => void;
  /** An entry saved from the editor. */
  onRecordSaved: (record: MealRecord) => void;
  /** Records changed by a list action (now "Keine Bewirtung"). */
  onRecordsSaved: (records: MealRecord[]) => void;
  /** Receipts that no longer exist. */
  onRecordsRemoved: (rowIds: string[]) => void;
  onContactCreated: (contact: Contact) => void;
  onOpenQueue: () => void;
}

/** Where the focus goes once the next render is on the page. */
type FocusRequest = { to: 'editor' } | { to: 'row'; rowId: string };

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
  contacts,
  settings,
  defaultHost,
  onSettingsChanged,
  onRecordSaved,
  onRecordsSaved,
  onRecordsRemoved,
  onContactCreated,
  onOpenQueue,
}: RegisterTabProps) {
  const actions = useReceiptActions({ onRecordsSaved, onRecordsRemoved, dismissedHint: DISMISSED_HINT });
  const { years, initial } = useMemo(() => registerYearChoices(records, new Date().getFullYear()), [records]);
  const [year, setYear] = useState(() => initial);
  const activeYear = years.includes(year) ? year : initial;
  const undated = useMemo(() => undatedMeals(records).length, [records]);
  const register = useMemo(() => buildRegister(records, settings, activeYear), [records, settings, activeYear]);

  const [settingBusy, setSettingBusy] = useState(false);
  const [settingError, setSettingError] = useState<string | null>(null);
  const [editingSetting, setEditingSetting] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportWarnings, setExportWarnings] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{ format: ExportFormat; count: number } | null>(null);

  // Editing one entry. Only the row id is kept: the entry itself is looked up
  // in the register on every render, so an entry that leaves the shown table
  // (deleted, taken out, no longer complete) closes its editor by itself.
  const editorId = useId();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDirty, setEditDirty] = useState(false);
  const [pendingDiscard, setPendingDiscard] = useState<{ run: () => void } | null>(null);
  const [savedNote, setSavedNote] = useState('');
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const editing = register.entries.find((e) => e.record.rowId === editingId) ?? null;
  const unsaved = editing !== null && editDirty;
  // Forget an entry that is gone, so it does not open again by itself should it
  // return to the register later (taken back from "Keine Bewirtung", say).
  if (editingId !== null && !editing) {
    setEditingId(null);
    setEditDirty(false);
  }

  // Runs after the render that opened or closed the editor, and after a
  // closing dialog has handed the focus back, so this is what finally holds.
  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.to === 'editor') {
      editorHeading.current?.scrollIntoView?.({ block: 'nearest' });
      editorHeading.current?.focus({ preventScroll: true });
    } else {
      editButtons.current.get(focusRequest.rowId)?.focus();
    }
  }, [focusRequest]);

  /** Close the editor without saving. With a row id the focus returns to that row's button. */
  const closeEditor = (returnTo: string | null) => {
    setEditingId(null);
    setEditDirty(false);
    if (returnTo) setFocusRequest({ to: 'row', rowId: returnTo });
  };

  /** Do something that drops the open draft: straight away when nothing is unsaved, else after asking. */
  const afterDiscard = (run: () => void) => {
    if (unsaved) setPendingDiscard({ run });
    else run();
  };

  const startEdit = (rowId: string) => {
    if (editing?.record.rowId === rowId) {
      setFocusRequest({ to: 'editor' });
      return;
    }
    afterDiscard(() => {
      setEditingId(rowId);
      setEditDirty(false);
      setSavedNote('');
      setFocusRequest({ to: 'editor' });
    });
  };

  const onEditSaved = (record: MealRecord, changed: boolean) => {
    onRecordSaved(record);
    // Nothing was written: the form says so itself, and the editor stays open.
    if (!changed) return;
    const moved = registerEditNotice(record, activeYear);
    if (moved) {
      // The row is gone from this table, so the notice takes the focus instead of its button.
      closeEditor(null);
      actions.notify(moved);
      return;
    }
    setSavedNote(`„${record.vendor || record.name || 'Beleg'}“: gespeichert.`);
    closeEditor(record.rowId);
  };

  const onEditDirty = useCallback((dirty: boolean) => setEditDirty(dirty), []);

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
          <select className="ui-input" style={{ minWidth: '7rem' }} value={activeYear}
            onChange={(e) => {
              // Another year has another table: the entry being edited is not in it.
              const next = Number(e.target.value);
              afterDiscard(() => {
                closeEditor(null);
                setYear(next);
              });
            }}
          >
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

      {undated > 0 && (
        <div className="ui-note ui-note-warn flex flex-wrap items-center justify-between gap-3">
          <span>
            {undated === 1
              ? '1 Bewirtung hat kein Datum und steht deshalb in keinem Jahr.'
              : `${undated} Bewirtungen haben kein Datum und stehen deshalb in keinem Jahr.`}
          </span>
          <button type="button" className="ui-btn ui-btn-sm" onClick={onOpenQueue}>
            Datum nachtragen
          </button>
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

      {/*
        Always in the page and never hidden, so a screen reader hears a save that
        left the entry where it is. Its line is reserved: the table does not move.
      */}
      <p role="status" className="min-h-4 text-xs" style={{ color: 'var(--muted)' }}>
        {savedNote}
      </p>

      {/*
        The editor sits above the table and appears without any motion. Its
        row stays marked below, and Escape or "Abbrechen" lead back to it.
      */}
      {editing && (
        <MealEditor
          id={editorId}
          headingRef={editorHeading}
          title={`Nr. ${editing.no} bearbeiten: ${editing.record.name || editing.record.vendor || 'Beleg'}`}
          record={editing.record}
          contacts={contacts}
          settings={settings}
          defaultHost={defaultHost}
          secondaryAction={{ label: 'Abbrechen', onClick: () => closeEditor(editing.record.rowId) }}
          onSaved={onEditSaved}
          onRecordsSaved={onRecordsSaved}
          onContactCreated={onContactCreated}
          onDirtyChange={onEditDirty}
          onKeyDown={(e) => {
            // The guest picker closes its own list on Escape and stops the key there.
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            const rowId = editing.record.rowId;
            afterDiscard(() => closeEditor(rowId));
          }}
        />
      )}

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
              {register.entries.map(({ no, record, deduction }) => {
                const isEditing = editing?.record.rowId === record.rowId;
                const spoken = `Nr. ${no}, ${record.place}, ${formatDay(record.date)}`;
                return (
                <tr
                  key={record.rowId}
                  className="ui-table-row border-t align-top"
                  data-editing={isEditing}
                  aria-current={isEditing ? 'true' : undefined}
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--foreground)' }}
                >
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
                    <div className="flex justify-end gap-0.5">
                      {/* The words change too, so the row being edited is not marked by colour alone. */}
                      <button
                        type="button"
                        ref={(el) => {
                          if (el) editButtons.current.set(record.rowId, el);
                          else editButtons.current.delete(record.rowId);
                        }}
                        className="ui-btn ui-btn-sm ui-btn-ghost whitespace-nowrap"
                        disabled={actions.busy}
                        aria-expanded={isEditing}
                        aria-controls={isEditing ? editorId : undefined}
                        aria-label={`${isEditing ? 'Wird bearbeitet' : 'Bearbeiten'}: ${spoken}`}
                        onClick={() => startEdit(record.rowId)}
                      >
                        {isEditing ? 'Wird bearbeitet' : 'Bearbeiten'}
                      </button>
                      {/* A complete entry carries tax weight: taking it out of the register always asks first. */}
                      <button
                        type="button"
                        className="ui-btn ui-btn-sm ui-btn-ghost whitespace-nowrap"
                        disabled={actions.busy}
                        aria-label={`Keine Bewirtung: ${spoken}`}
                        onClick={() => actions.markNotMeal([record], { confirm: true })}
                      >
                        Keine Bewirtung
                      </button>
                      <button
                        type="button"
                        className="ui-btn ui-btn-sm ui-btn-ghost ui-btn-danger"
                        disabled={actions.busy}
                        aria-label={`Löschen: ${spoken}`}
                        onClick={() => actions.requestDelete([record])}
                      >
                        Löschen
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })}
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
                <span style={{ color: 'var(--muted)' }} title={`fehlt: ${missingList(missing)}`}>
                  {missingSummary(missing)}
                  <span className="sr-only">: {missingList(missing)}</span>
                </span>
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
      <ConfirmDialog
        open={pendingDiscard !== null}
        title="Ungespeicherte Änderungen verwerfen?"
        confirmLabel="Änderungen verwerfen"
        cancelLabel="Weiter bearbeiten"
        danger
        onCancel={() => setPendingDiscard(null)}
        onConfirm={() => {
          const pending = pendingDiscard;
          setPendingDiscard(null);
          pending?.run();
        }}
      >
        {editing && (
          <p>
            Die Änderungen an Nr. {editing.no} ({editing.record.name || editing.record.vendor || 'Beleg'}) sind noch
            nicht gespeichert. Der Eintrag bleibt dann so, wie er im Verzeichnis steht.
          </p>
        )}
      </ConfirmDialog>
      {actions.overlays}
    </div>
  );
}
