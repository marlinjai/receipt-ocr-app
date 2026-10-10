'use client';

import type { KeyboardEventHandler, Ref } from 'react';
import MealDetailsForm from '@/components/meals/MealDetailsForm';
import ReceiptViewer from '@/components/meals/ReceiptViewer';
import type { Contact } from '@/lib/contacts/store';
import { formatDay } from '@/lib/meals/messages';
import type { MealGuestEntry, MealRecord, MealTaxSettings } from '@/lib/meals/types';
import { createContact, saveMeal, saveReceiptRotation } from './actions';

interface MealEditorProps {
  record: MealRecord;
  contacts: Contact[];
  settings: MealTaxSettings;
  defaultHost: string;
  /** Called after a successful save with the stored record. */
  onSaved: (record: MealRecord, changed: boolean) => void;
  /** A stored receipt rotation changes the record too. */
  onRecordsSaved: (records: MealRecord[]) => void;
  onContactCreated: (contact: Contact) => void;
  /** The line above the form. Defaults to the receipt's name. */
  title?: string;
  saveLabel?: string;
  /** A second button beside save, for example "Abbrechen" in the register. */
  secondaryAction?: { label: string; onClick: () => void };
  /** Queue: guests of the entry saved just before, offered as one tap. */
  previousGuests?: MealGuestEntry[];
  /** Queue: the host as typed, offered on the next receipt. */
  onHostEntered?: (host: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** With a ref the heading can take the focus when the editor opens. */
  headingRef?: Ref<HTMLHeadingElement>;
  id?: string;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
}

/**
 * One meal being worked on: the details form with the receipt beside it. The
 * queue of incomplete meals and the register both use this, so a guest created
 * from the picker, a stored receipt rotation and the save itself behave the
 * same wherever an entry is opened.
 */
export default function MealEditor({
  record,
  contacts,
  settings,
  defaultHost,
  onSaved,
  onRecordsSaved,
  onContactCreated,
  title,
  saveLabel,
  secondaryAction,
  previousGuests,
  onHostEntered,
  onDirtyChange,
  headingRef,
  id,
  onKeyDown,
}: MealEditorProps) {
  return (
    <section
      id={id}
      aria-label="Angaben zur Bewirtung"
      onKeyDown={onKeyDown}
      className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] xl:items-start 2xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]"
    >
      <div className="glass-panel rounded-xl p-4 sm:p-6">
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <h2
            ref={headingRef}
            tabIndex={headingRef ? -1 : undefined}
            className="min-w-0 text-lg font-semibold leading-snug outline-none"
            style={{ color: 'var(--foreground)' }}
          >
            {title ?? (record.name || record.vendor || 'Beleg')}
          </h2>
          <p className="text-sm tabular-nums" style={{ color: 'var(--muted)' }}>
            {formatDay(record.date)}
            {record.gross ? ` · ${record.gross.toFixed(2).replace('.', ',')} ${record.currency}` : ''}
          </p>
        </div>
        <MealDetailsForm
          record={record}
          contacts={contacts}
          settings={settings}
          defaultHost={defaultHost}
          onHostEntered={onHostEntered}
          previousGuests={previousGuests}
          saveLabel={saveLabel}
          secondaryAction={secondaryAction}
          onSave={saveMeal}
          onCreateContact={createContact}
          onContactCreated={onContactCreated}
          onSaved={onSaved}
          onDirtyChange={onDirtyChange}
        />
        <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
          Strg oder Cmd + Enter speichert.{secondaryAction ? ' Esc bricht ab.' : ''}
        </p>
      </div>
      {/*
        The receipt is what gets read while typing guests and occasion, so
        it has the widest column and the full height of the window. Below
        the two-column width it comes FIRST, above the form.
      */}
      <ReceiptViewer
        key={record.rowId}
        className="h-[62svh] max-xl:order-first xl:sticky xl:top-4 xl:h-[calc(100svh-2rem)]"
        files={record.files}
        onRotate={async (file, rotation) => {
          try {
            const result = await saveReceiptRotation(record.rowId, file.refId, rotation);
            if (!result.ok) return false;
            onRecordsSaved([result.value.record]);
            return true;
          } catch {
            return false;
          }
        }}
      />
    </section>
  );
}
