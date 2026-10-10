'use client';

import { useId, useState, type ReactNode } from 'react';
import type { DirectoryContact, DirectoryField, ErasePreview } from '@/lib/contacts/directory';
import { contactPlace } from '@/lib/contacts/contact-list';
import { eraseConfirmation } from '@/lib/contacts/directory-messages';
import { PREFERRED_CONTACT_LABELS } from '@/lib/contacts/field-form';

/**
 * Everything about one contact in one place: what is recorded, the link between
 * a person and its organization, the customer number, and at the bottom the
 * actions that are needed less often. It shows and asks; the page saves.
 */

interface ContactPanelProps {
  contact: DirectoryContact;
  /** The company's active custom fields, for the labels of their values. */
  fields: readonly DirectoryField[];
  /** Active organizations a person can be linked to. */
  organizations: readonly DirectoryContact[];
  /** For an organization: the persons linked to it. */
  members: readonly DirectoryContact[];
  /** The key of the action that is running, null when idle. */
  busy: string | null;
  /** Set while the erase confirmation is shown for this contact. */
  erasePreview: ErasePreview | null;
  onEdit: () => void;
  onLink: (organizationId: string | null) => void;
  onAssignNumber: () => void;
  onExport: () => void;
  onToggleArchived: () => void;
  onAskErase: () => void;
  onConfirmErase: () => void;
  onCancelErase: () => void;
  onOpenContact: (id: string) => void;
}

function customValueText(value: unknown): string {
  if (value === true) return 'Ja';
  if (value === false) return 'Nein';
  if (Array.isArray(value)) return value.map(String).join(', ');
  return String(value);
}

/** The recorded details as label and value pairs; empty ones are left out. */
function detailRows(c: DirectoryContact, fields: readonly DirectoryField[]): Array<[string, string]> {
  const rows: Array<[string, string | null]> =
    c.kind === 'organization'
      ? [
          ['Rechtsform', c.legalForm],
          ['Anschrift', [c.addressLine1, c.addressLine2, [contactPlace(c), c.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || null],
          ['Umsatzsteuer-ID', c.vatId],
        ]
      : [['Firma oder Funktion', c.companyOrRole || null]];
  rows.push(
    ['E-Mail', c.email],
    ['Telefon', c.phone],
    ['Bevorzugter Kontaktweg', c.preferredContact ? (PREFERRED_CONTACT_LABELS[c.preferredContact] ?? c.preferredContact) : null],
  );
  for (const f of fields) {
    const value = c.customFields[f.key];
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) continue;
    rows.push([f.label, customValueText(value)]);
  }
  rows.push(['Notiz', c.note]);
  return rows.filter((row): row is [string, string] => Boolean(row[1]));
}

export default function ContactPanel(props: ContactPanelProps) {
  const { contact: c, busy } = props;
  const id = useId();
  const idle = busy === null;
  const details = detailRows(c, props.fields);

  return (
    <div className="space-y-5">
      {c.archived && (
        <p className="ui-note ui-note-warn">
          Dieser Kontakt ist archiviert. Er wird bei neuen Bewirtungen nicht mehr vorgeschlagen; bestehende Bewirtungen behalten ihn.
        </p>
      )}

      <PanelSection title="Angaben" headingId={`${id}-details`}>
        {details.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Außer dem Namen ist noch nichts hinterlegt.
          </p>
        ) : (
          <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
            {details.map(([label, value]) => (
              <div key={label} className="contents">
                <dt style={{ color: 'var(--muted)' }}>{label}</dt>
                <dd className="break-words" style={{ color: 'var(--foreground)' }}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {!c.archived && (
          <button type="button" className="ui-btn ui-btn-sm mt-3" disabled={!idle} onClick={props.onEdit}>
            Bearbeiten
          </button>
        )}
      </PanelSection>

      {c.kind === 'person' && !c.archived && (
        <PanelSection title="Organisation" headingId={`${id}-org`}>
          {/* Keyed by what is stored, so the choice starts over whenever the link changed. */}
          <OrganizationLink
            key={`${c.id}:${c.organizationId ?? ''}:${c.version}`}
            contact={c}
            organizations={props.organizations}
            labelledBy={`${id}-org`}
            busy={busy}
            onLink={props.onLink}
            onOpenContact={props.onOpenContact}
          />
        </PanelSection>
      )}

      {c.kind === 'organization' && (
        <PanelSection title={`Personen (${props.members.length})`} headingId={`${id}-members`}>
          {props.members.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              Noch keine Person verknüpft. Die Verknüpfung wird bei der Person gesetzt.
            </p>
          ) : (
            <ul className="space-y-1">
              {props.members.map((m) => (
                <li key={m.id}>
                  <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => props.onOpenContact(m.id)}>
                    {m.name}
                    {m.archived && <span style={{ color: 'var(--muted)' }}>(archiviert)</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </PanelSection>
      )}

      <PanelSection title="Kundennummer" headingId={`${id}-number`}>
        {c.customerNumber ? (
          <p className="text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>
            {c.customerNumber}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              Noch keine vergeben.
            </p>
            {!c.archived && (
              <button type="button" className="ui-btn ui-btn-sm" disabled={!idle} onClick={props.onAssignNumber}>
                {busy === 'number' ? 'Bitte warten…' : 'Kundennummer vergeben'}
              </button>
            )}
          </div>
        )}
      </PanelSection>

      <PanelSection title="Weitere Aktionen" headingId={`${id}-more`}>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="ui-btn ui-btn-sm" disabled={!idle} onClick={props.onExport}>
            {busy === 'export' ? 'Bitte warten…' : 'Exportieren'}
          </button>
          {c.kind === 'person' && (
            <button type="button" className="ui-btn ui-btn-sm" disabled={!idle} onClick={props.onToggleArchived}>
              {busy === 'archive' ? 'Bitte warten…' : c.archived ? 'Wiederherstellen' : 'Archivieren'}
            </button>
          )}
        </div>

        <div className="mt-4 border-t pt-4" style={{ borderColor: 'var(--border-subtle)' }}>
          {props.erasePreview ? (
            <div role="alertdialog" aria-labelledby={`${id}-erase-title`} aria-describedby={`${id}-erase-text`} className="ui-note ui-note-danger space-y-3">
              <h4 id={`${id}-erase-title`} className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
                {c.name} endgültig löschen?
              </h4>
              <p id={`${id}-erase-text`} className="text-sm" style={{ color: 'var(--foreground)' }}>
                {eraseConfirmation(props.erasePreview, c.kind)}
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" disabled={!idle} onClick={props.onConfirmErase}>
                  {busy === 'erase' ? 'Wird gelöscht…' : 'Endgültig löschen'}
                </button>
                <button data-focus="erase-cancel" type="button" className="ui-btn ui-btn-sm" disabled={!idle} onClick={props.onCancelErase}>
                  Abbrechen
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button data-focus="erase" type="button" className="ui-btn ui-btn-sm ui-btn-danger" disabled={!idle} onClick={props.onAskErase}>
                {busy === 'preview' ? 'Bitte warten…' : 'Löschen'}
              </button>
              <p className="min-w-0 flex-1 text-xs" style={{ color: 'var(--muted)' }}>
                Löscht den Kontakt endgültig. Vorher wird gezeigt, was das für bestehende Bewirtungen bedeutet.
              </p>
            </div>
          )}
        </div>
      </PanelSection>
    </div>
  );
}

function PanelSection({ title, headingId, children }: { title: string; headingId: string; children: ReactNode }) {
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="ui-label">
        {title}
      </h3>
      {children}
    </section>
  );
}

function OrganizationLink(props: {
  contact: DirectoryContact;
  organizations: readonly DirectoryContact[];
  labelledBy: string;
  busy: string | null;
  onLink: (organizationId: string | null) => void;
  onOpenContact: (id: string) => void;
}) {
  const { contact: c, organizations } = props;
  const stored = c.organizationId ?? '';
  const [target, setTarget] = useState(stored);
  // A linked organization that is archived is not offered for new links, but must still be shown as the current one.
  const listed = organizations.some((o) => o.id === stored) || stored === '';

  if (organizations.length === 0 && stored === '') {
    return (
      <p className="text-sm" style={{ color: 'var(--muted)' }}>
        Noch keine Organisation angelegt. Über „Kontakt anlegen“ entsteht eine, danach lässt sich diese Person hier verknüpfen.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className="ui-input min-w-0 flex-1"
        style={{ flexBasis: '12rem' }}
        aria-labelledby={props.labelledBy}
        value={target}
        disabled={props.busy !== null}
        onChange={(e) => setTarget(e.target.value)}
      >
        <option value="">Keine Organisation</option>
        {!listed && <option value={stored}>{c.organizationName ?? 'Verknüpfte Organisation'}</option>}
        {organizations.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <button type="button" className="ui-btn ui-btn-sm" disabled={props.busy !== null || target === stored} onClick={() => props.onLink(target || null)}>
        {props.busy === 'link' ? 'Bitte warten…' : 'Verknüpfen'}
      </button>
      {stored !== '' && (
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => props.onOpenContact(stored)}>
          Organisation öffnen
        </button>
      )}
    </div>
  );
}
