'use client';

import { useId, useMemo, useState } from 'react';
import type { Contact, ContactInput } from '@/lib/contacts/store';
import { CONSUMPTION_TYPES, MEAL_CATEGORY, MEAL_TYPES } from '@/lib/receipts-constants';
import {
  draftFromRecord,
  draftToInput,
  isDraftDirty,
  previewRecord,
  type DraftField,
  type MealDraft,
} from '@/lib/meals/form-state';
import type { MealDetailsInput } from '@/lib/meals/input';
import { EXCLUSION_LABELS, formatEuro, mealActionMessage } from '@/lib/meals/messages';
import {
  MISSING_FIELD_LABELS,
  hostMustBeNamedOnReceipt,
  mealDeduction,
  mealStatus,
  type MissingField,
} from '@/lib/meals/rules';
import type { MealGuestEntry, MealRecord, MealTaxSettings } from '@/lib/meals/types';
import GuestPicker, { type CreateContactResult } from './GuestPicker';

export type SaveMealResult =
  | { ok: true; value: { record: MealRecord; changed: boolean } }
  | { ok: false; error: string; detail?: string };

interface MealDetailsFormProps {
  record: MealRecord;
  contacts: Contact[];
  settings: MealTaxSettings;
  defaultHost: string;
  onSave: (rowId: string, input: MealDetailsInput) => Promise<SaveMealResult>;
  onCreateContact: (input: ContactInput) => Promise<CreateContactResult>;
  onContactCreated?: (contact: Contact) => void;
  /** Called after a successful save with the stored record. */
  onSaved?: (record: MealRecord, changed: boolean) => void;
  /** Queue mode: guests of the entry saved just before, offered as one tap. */
  previousGuests?: MealGuestEntry[];
  /** Queue mode: label of the primary button, e.g. "Speichern und weiter". */
  saveLabel?: string;
  /** Shown next to save, e.g. "Später" on the capture sheet. */
  secondaryAction?: { label: string; onClick: () => void };
}

/**
 * The meal details of one receipt. The same component serves the receipt
 * detail panel, the queue of incomplete meals and the capture sheet.
 *
 * Status and deductible amount shown here are computed from the DRAFT by the
 * same rules that build the register, so "vollständig" on screen means the
 * entry will be in the register once saved. Saving is allowed at any degree
 * of completeness: a half-filled entry simply stays in the queue.
 */
export default function MealDetailsForm(props: MealDetailsFormProps) {
  // Keyed on the row: another receipt (queue advance) starts a fresh draft,
  // while a refreshed copy of the SAME row never wipes what is being typed.
  return <MealDetailsFormInner key={props.record.rowId} {...props} />;
}

function MealDetailsFormInner({
  record,
  contacts,
  settings,
  defaultHost,
  onSave,
  onCreateContact,
  onContactCreated,
  onSaved,
  previousGuests,
  saveLabel = 'Speichern',
  secondaryAction,
}: MealDetailsFormProps) {
  const ids = useId();
  const [draft, setDraft] = useState<MealDraft>(() => draftFromRecord(record, { host: defaultHost }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<DraftField, string>>>({});
  const [showTaxLines, setShowTaxLines] = useState(() => (record.taxLines?.length ?? 0) > 0);

  const set = <K extends keyof MealDraft>(key: K, value: MealDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setSavedNote(null);
  };

  const preview = useMemo(() => previewRecord(record, draft), [record, draft]);
  const status = mealStatus(preview);
  const deduction = mealDeduction(preview, settings);
  const dirty = isDraftDirty(record, draft);
  const isExternal = draft.mealType === 'business_meal_external';
  const notMealCategory = record.category !== MEAL_CATEGORY;
  const missing: MissingField[] = status.kind === 'incomplete' ? status.missing : [];
  const isMissing = (field: MissingField) => missing.includes(field);

  const submit = async () => {
    if (saving) return;
    const parsed = draftToInput(draft);
    if (!parsed.ok) {
      setFieldErrors(parsed.errors);
      setError('Bitte die markierten Felder korrigieren.');
      return;
    }
    setFieldErrors({});
    setError(null);
    setSaving(true);
    try {
      const result = await onSave(record.rowId, parsed.input);
      if (!result.ok) {
        setError(mealActionMessage(result.error, result.detail));
        return;
      }
      setSavedNote(result.value.changed ? 'Gespeichert.' : 'Keine Änderungen, nichts gespeichert.');
      onSaved?.(result.value.record, result.value.changed);
    } catch {
      // A thrown action (network down, server unreachable): say so, keep the draft.
      setError(mealActionMessage('failed'));
    } finally {
      setSaving(false);
    }
  };

  const fieldId = (name: string) => `${ids}-${name}`;

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          void submit();
        }
      }}
    >
      {notMealCategory && (
        <p className="ui-note ui-note-warn" role="status">
          Dieser Beleg ist nicht mehr als Bewirtung kategorisiert. Die Angaben unten sind gespeichert, der Beleg steht
          aber nicht im Verzeichnis. Wird die Kategorie wieder auf Bewirtung gesetzt, erscheint der Eintrag unverändert.
        </p>
      )}

      <div>
        <span className="ui-label" id={fieldId('type')}>
          Art der Bewirtung
        </span>
        <div className="ui-seg" role="group" aria-labelledby={fieldId('type')}>
          {MEAL_TYPES.map((t) => (
            <button key={t.key} type="button" aria-pressed={draft.mealType === t.key} onClick={() => set('mealType', t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        {!isExternal && draft.mealType && (
          <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
            {draft.mealType === 'not_a_meal'
              ? 'Der Beleg wird nicht als Bewirtung geführt und verlässt die Liste der offenen Bewirtungen.'
              : 'Wird erfasst und gesondert gezählt, steht aber nicht im Verzeichnis der zu 70 % abziehbaren Bewirtungen.'}
          </p>
        )}
      </div>

      {isExternal && (
        <>
          <div>
            <span className="ui-label">Bewirtete Personen</span>
            <GuestPicker
              guests={draft.guests}
              contacts={contacts}
              onChange={(guests) => set('guests', guests)}
              onCreateContact={onCreateContact}
              onContactCreated={onContactCreated}
              disabled={saving}
              invalid={isMissing('guests')}
              describedBy={fieldId('guests-hint')}
            />
            {previousGuests && previousGuests.length > 0 && draft.guests.length === 0 && (
              <button type="button" className="ui-btn ui-btn-sm mt-2" onClick={() => set('guests', previousGuests)}>
                Gleiche Teilnehmer wie zuletzt ({previousGuests.length})
              </button>
            )}
            {draft.guests.length === 0 && (
              <div id={fieldId('guests-hint')} className="ui-note mt-2">
                <p>
                  Ohne Gast ist es keine Bewirtung: Der Gastgeber selbst zählt nicht. Allein gegessen?
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className="ui-btn ui-btn-sm" onClick={() => set('mealType', 'travel_meal')}>
                    Verpflegung auf Reise
                  </button>
                  <button type="button" className="ui-btn ui-btn-sm" onClick={() => set('mealType', 'not_a_meal')}>
                    Keine Bewirtung
                  </button>
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="ui-label" htmlFor={fieldId('occasion')}>
              Anlass
            </label>
            <textarea
              id={fieldId('occasion')}
              className="ui-input"
              rows={2}
              value={draft.occasion}
              aria-invalid={isMissing('occasionTooGeneric') || undefined}
              placeholder="Worum ging es konkret? Zum Beispiel: Abstimmung Angebot Fotoproduktion Frühjahr"
              onChange={(e) => set('occasion', e.target.value)}
            />
            {isMissing('occasionTooGeneric') && (
              <p className="mt-1 text-xs" style={{ color: 'var(--accent)' }}>
                Zu allgemein. Das Finanzamt verlangt den konkreten Anlass: bitte das Thema benennen.
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="ui-label" htmlFor={fieldId('place')}>
                Ort (Name und Anschrift)
              </label>
              <input id={fieldId('place')} className="ui-input" value={draft.place} onChange={(e) => set('place', e.target.value)} />
            </div>
            <div>
              <label className="ui-label" htmlFor={fieldId('host')}>
                Gastgeber
              </label>
              <input id={fieldId('host')} className="ui-input" value={draft.host} autoComplete="name" onChange={(e) => set('host', e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <label className="ui-label" htmlFor={fieldId('date')}>
                Datum
              </label>
              <input
                id={fieldId('date')}
                type="date"
                className="ui-input"
                value={draft.date}
                aria-invalid={Boolean(fieldErrors.date) || undefined}
                onChange={(e) => set('date', e.target.value)}
              />
              {fieldErrors.date && <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>{fieldErrors.date}</p>}
            </div>
            <div>
              <label className="ui-label" htmlFor={fieldId('gross')}>
                Rechnungsbetrag {record.currency !== 'EUR' ? `(${record.currency})` : ''}
              </label>
              <input
                id={fieldId('gross')}
                className="ui-input"
                inputMode="decimal"
                value={draft.gross}
                aria-invalid={Boolean(fieldErrors.gross) || undefined}
                onChange={(e) => set('gross', e.target.value)}
              />
              {fieldErrors.gross && <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>{fieldErrors.gross}</p>}
            </div>
            <div>
              <label className="ui-label" htmlFor={fieldId('tip')}>
                Trinkgeld
              </label>
              <input
                id={fieldId('tip')}
                className="ui-input"
                inputMode="decimal"
                placeholder="0,00"
                value={draft.tip}
                aria-invalid={Boolean(fieldErrors.tip) || undefined}
                aria-describedby={fieldId('tip-hint')}
                onChange={(e) => set('tip', e.target.value)}
              />
              {fieldErrors.tip && <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>{fieldErrors.tip}</p>}
            </div>
          </div>
          <p id={fieldId('tip-hint')} className="-mt-2 text-xs" style={{ color: 'var(--muted)' }}>
            Trinkgeld zusätzlich zum Rechnungsbetrag. Es zählt nur, wenn es auf dem Beleg vermerkt ist.
          </p>

          <div>
            <span className="ui-label" id={fieldId('consumption')}>
              Verzehr
            </span>
            <div className="ui-seg" role="group" aria-labelledby={fieldId('consumption')}>
              {CONSUMPTION_TYPES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={draft.consumption === t.key}
                  onClick={() => set('consumption', draft.consumption === t.key ? null : t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {settings.smallBusiness !== true && (
            <div>
              <button
                type="button"
                className="text-xs underline underline-offset-2"
                style={{ color: 'var(--muted)' }}
                aria-expanded={showTaxLines}
                onClick={() => setShowTaxLines((v) => !v)}
              >
                Steuerzeilen des Belegs {showTaxLines ? 'ausblenden' : 'erfassen'}
              </button>
              {showTaxLines && (
                <div className="mt-2 space-y-2">
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>
                    Je Steuersatz eine Zeile, so wie auf dem Beleg ausgewiesen. Ohne Steuerzeilen wird die Umsatzsteuer
                    nach dem Belegdatum geschätzt und als geschätzt gekennzeichnet.
                  </p>
                  {draft.taxLines.map((line, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2">
                      <input className="ui-input" inputMode="decimal" aria-label={`Steuersatz Zeile ${i + 1} in Prozent`} placeholder="Satz %" value={line.rate}
                        onChange={(e) => set('taxLines', draft.taxLines.map((l, j) => (j === i ? { ...l, rate: e.target.value } : l)))} />
                      <input className="ui-input" inputMode="decimal" aria-label={`Netto Zeile ${i + 1}`} placeholder="Netto" value={line.net}
                        onChange={(e) => set('taxLines', draft.taxLines.map((l, j) => (j === i ? { ...l, net: e.target.value } : l)))} />
                      <input className="ui-input" inputMode="decimal" aria-label={`Steuer Zeile ${i + 1}`} placeholder="Steuer" value={line.tax}
                        onChange={(e) => set('taxLines', draft.taxLines.map((l, j) => (j === i ? { ...l, tax: e.target.value } : l)))} />
                      <button type="button" className="ui-btn ui-btn-danger" aria-label={`Steuerzeile ${i + 1} entfernen`}
                        onClick={() => set('taxLines', draft.taxLines.filter((_, j) => j !== i))}>
                        Entfernen
                      </button>
                    </div>
                  ))}
                  <button type="button" className="ui-btn ui-btn-sm" onClick={() => set('taxLines', [...draft.taxLines, { rate: '', net: '', tax: '' }])}>
                    Steuerzeile hinzufügen
                  </button>
                  {fieldErrors.taxLines && <p className="text-xs" style={{ color: 'var(--danger)' }}>{fieldErrors.taxLines}</p>}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Status of the draft, by the same rules as the register. */}
      <div aria-live="polite">
        {status.kind === 'complete' && (
          <div className="ui-note ui-note-ok">
            <p className="font-medium">Vollständig.</p>
            {deduction.kind === 'ok' && (
              <p className="mt-1">
                Abziehbar 70 %: <strong>{formatEuro(deduction.deductible)}</strong> von {formatEuro(deduction.base)} (
                {deduction.basis === 'gross' ? 'brutto' : 'netto'} zuzüglich Trinkgeld), nicht abziehbar{' '}
                {formatEuro(deduction.nonDeductible)}.
                {deduction.vatEstimated && ' Umsatzsteuer geschätzt, da keine Steuerzeilen erfasst sind.'}
                {deduction.vatLinesMismatch && ' Achtung: Die Steuerzeilen ergeben nicht den Rechnungsbetrag.'}
              </p>
            )}
            {deduction.kind === 'setting_missing' && (
              <p className="mt-1">
                Der abziehbare Betrag wird angezeigt, sobald im Reiter Verzeichnis die Frage zur
                Kleinunternehmerregelung beantwortet ist.
              </p>
            )}
          </div>
        )}
        {status.kind === 'incomplete' && (
          <div className="ui-note ui-note-warn">
            <p>
              <span className="font-medium">Noch nicht vollständig.</span> Es fehlt:{' '}
              {status.missing.map((m) => MISSING_FIELD_LABELS[m]).join(', ')}.
            </p>
            <p className="mt-1" style={{ color: 'var(--muted)' }}>
              Speichern geht trotzdem: Der Beleg bleibt dann in der Liste der offenen Bewirtungen.
            </p>
          </div>
        )}
        {status.kind === 'excluded' && (
          <p className="ui-note">{EXCLUSION_LABELS[status.reason]}: wird gesondert gezählt, nicht im Verzeichnis.</p>
        )}
        {isExternal && hostMustBeNamedOnReceipt(preview, settings) && (
          <p className="ui-note ui-note-warn mt-2">
            Der Rechnungsbetrag liegt über {formatEuro(settings.hostAddressThresholdEur)}. Ab dieser Grenze muss die
            Rechnung Namen und Anschrift des Gastgebers tragen. Bitte auf dem Beleg prüfen.
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="ui-note ui-note-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="ui-btn ui-btn-primary" disabled={saving}>
          {saving ? 'Wird gespeichert…' : saveLabel}
        </button>
        {secondaryAction && (
          <button type="button" className="ui-btn" onClick={secondaryAction.onClick} disabled={saving}>
            {secondaryAction.label}
          </button>
        )}
        <span role="status" className="text-xs" style={{ color: 'var(--muted)' }}>
          {savedNote ?? (dirty ? 'Ungespeicherte Änderungen' : '')}
        </span>
      </div>
    </form>
  );
}
