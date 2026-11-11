'use client';

import { useState, type KeyboardEvent } from 'react';
import type { DirectoryAffiliation, DirectoryContact } from '@/lib/contacts/directory';

/**
 * The two lists of the contact panel that show who belongs to whom: a person's
 * affiliations (business, role, dates) and an organization's people with their
 * roles. They show and ask; the page saves, with the version it read.
 *
 * The person's old free text (`companyOrRole`) is never turned into a role by
 * itself: next to an empty role it is shown as "Früher erfasst" and a person
 * adopts it with an explicit click.
 */

export interface AffiliationHandlers {
  busy: string | null;
  onAdd: (input: { personId: string; organizationId: string; role: string; startedOn: string }) => void;
  onChangeRole: (a: DirectoryAffiliation, role: string) => void;
  onEnd: (a: DirectoryAffiliation) => void;
  onRemove: (a: DirectoryAffiliation) => void;
  onSetPrimary: (a: DirectoryAffiliation) => void;
  onOpenContact: (id: string) => void;
}

/** 'YYYY-MM-DD' as 'TT.MM.JJJJ'. */
export function dateText(value: string | null): string {
  if (!value) return '';
  const [y, m, d] = value.split('-');
  return `${d}.${m}.${y}`;
}

function period(a: DirectoryAffiliation): string {
  if (a.startedOn && a.endedOn) return `${dateText(a.startedOn)} bis ${dateText(a.endedOn)}`;
  if (a.endedOn) return `bis ${dateText(a.endedOn)}`;
  if (a.startedOn) return `seit ${dateText(a.startedOn)}`;
  return '';
}

function RoleEditor(props: { a: DirectoryAffiliation; label: string; busy: string | null; onSave: (role: string) => void }) {
  const { a } = props;
  const [role, setRole] = useState(a.role);
  const idle = props.busy === null;
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (idle && role.trim() !== a.role) props.onSave(role.trim());
      }}
    >
      <input
        className="ui-input min-w-0 flex-1"
        style={{ flexBasis: '10rem' }}
        aria-label={`Funktion ${props.label}`}
        placeholder="Funktion (z. B. Einkauf)"
        maxLength={160}
        value={role}
        disabled={!idle}
        onChange={(e) => setRole(e.target.value)}
      />
      <button type="submit" className="ui-btn ui-btn-sm" disabled={!idle || role.trim() === a.role}>
        {props.busy === 'affiliation' ? 'Bitte warten…' : 'Funktion speichern'}
      </button>
    </form>
  );
}

function Row(props: {
  a: DirectoryAffiliation;
  /** The name shown as the row's title: the business for a person's list, the person for an organization's. */
  title: string;
  openId: string;
  legacyText: string;
  showPrimary: boolean;
  h: AffiliationHandlers;
}) {
  const { a, h } = props;
  const idle = h.busy === null;
  const ended = a.endedOn !== null;
  return (
    <li className="rounded border p-2" style={{ borderColor: 'var(--border-subtle)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => h.onOpenContact(props.openId)}>
          {props.title}
        </button>
        {a.primary && props.showPrimary && <span className="text-xs" style={{ color: 'var(--muted)' }}>Hauptzuordnung</span>}
        {period(a) && <span className="text-xs tabular-nums" style={{ color: 'var(--muted)' }}>{period(a)}</span>}
        {ended && a.role && <span className="text-sm">{a.role}</span>}
        {ended && !a.role && <span className="text-xs" style={{ color: 'var(--muted)' }}>Keine Funktion erfasst</span>}
      </div>
      {!ended && (
        <div className="mt-2 space-y-2">
          <RoleEditor key={`${a.id}:${a.version}`} a={a} label={`bei ${props.title}`} busy={h.busy} onSave={(role) => h.onChangeRole(a, role)} />
          {a.role === '' && props.legacyText !== '' && (
            <p className="flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
              <span>Früher erfasst: {props.legacyText}</span>
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={!idle} onClick={() => h.onChangeRole(a, props.legacyText)}>
                Als Funktion übernehmen
              </button>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ui-btn ui-btn-sm" disabled={!idle} onClick={() => h.onEnd(a)}>
              Zuordnung beenden
            </button>
            {props.showPrimary && !a.primary && (
              <button type="button" className="ui-btn ui-btn-sm" disabled={!idle} onClick={() => h.onSetPrimary(a)}>
                Als Hauptzuordnung
              </button>
            )}
            <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={!idle} onClick={() => h.onRemove(a)}>
              Fehleintrag entfernen
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function History({ rows, title, h }: { rows: DirectoryAffiliation[]; title: (a: DirectoryAffiliation) => string; h: AffiliationHandlers }) {
  if (rows.length === 0) return null;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-sm" style={{ color: 'var(--muted)' }}>
        Beendete Zuordnungen ({rows.length})
      </summary>
      <ul className="mt-2 space-y-1">
        {rows.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span>{title(a)}</span>
            <span className="text-xs tabular-nums" style={{ color: 'var(--muted)' }}>{period(a)}</span>
            <span>{a.role || <span style={{ color: 'var(--muted)' }}>Keine Funktion erfasst</span>}</span>
            <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={h.busy !== null} onClick={() => h.onRemove(a)}>
              Entfernen
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

interface AddFormProps {
  /** The choices: businesses for a person, persons for an organization. */
  options: readonly DirectoryContact[];
  selectLabel: string;
  emptyText: string;
  submitLabel: string;
  busy: string | null;
  onSubmit: (id: string, role: string, startedOn: string) => void;
}

function AddForm(props: AddFormProps) {
  const [target, setTarget] = useState('');
  const [role, setRole] = useState('');
  const [startedOn, setStartedOn] = useState('');
  const idle = props.busy === null;
  if (props.options.length === 0) {
    return (
      <p className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>
        {props.emptyText}
      </p>
    );
  }
  const submit = () => {
    if (!idle || !target) return;
    props.onSubmit(target, role.trim(), startedOn);
    setTarget('');
    setRole('');
    setStartedOn('');
  };
  const enter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };
  // A group, not a form: the page tells its own forms (the contact form) apart by their role.
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2" role="group" aria-label={props.submitLabel}>
      <select className="ui-input sm:col-span-2" aria-label={props.selectLabel} value={target} disabled={!idle} onChange={(e) => setTarget(e.target.value)}>
        <option value="">{props.selectLabel}…</option>
        {props.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <input className="ui-input" aria-label="Funktion" placeholder="Funktion (optional)" maxLength={160} value={role} disabled={!idle} onKeyDown={enter} onChange={(e) => setRole(e.target.value)} />
      <input className="ui-input" type="date" aria-label="Seit (optional)" value={startedOn} disabled={!idle} onKeyDown={enter} onChange={(e) => setStartedOn(e.target.value)} />
      <div className="sm:col-span-2">
        <button type="button" className="ui-btn ui-btn-sm" disabled={!idle || !target} onClick={submit}>
          {props.busy === 'affiliation' ? 'Bitte warten…' : props.submitLabel}
        </button>
      </div>
    </div>
  );
}

/** A person's affiliations: every business with the role there, plus the history. */
export function PersonAffiliations(props: {
  contact: DirectoryContact;
  affiliations: readonly DirectoryAffiliation[];
  organizations: readonly DirectoryContact[];
  h: AffiliationHandlers;
}) {
  const { contact: c, h } = props;
  const mine = props.affiliations.filter((a) => a.personId === c.id);
  const open = mine.filter((a) => a.endedOn === null);
  const ended = mine.filter((a) => a.endedOn !== null);
  const taken = new Set(open.map((a) => a.organizationId));
  const choices = props.organizations.filter((o) => !taken.has(o.id));
  return (
    <div>
      {open.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Keiner Organisation zugeordnet.
        </p>
      ) : (
        <ul className="space-y-2">
          {open.map((a) => (
            <Row key={a.id} a={a} title={a.organizationName} openId={a.organizationId} legacyText={c.companyOrRole} showPrimary={open.length > 1} h={h} />
          ))}
        </ul>
      )}
      <History rows={ended} title={(a) => a.organizationName} h={h} />
      <AddForm
        options={choices}
        selectLabel="Organisation wählen"
        emptyText={props.organizations.length === 0 ? 'Noch keine Organisation angelegt. Über „Kontakt anlegen“ entsteht eine, danach lässt sich diese Person ihr zuordnen.' : 'Diese Person ist allen vorhandenen Organisationen zugeordnet.'}
        submitLabel="Zuordnen"
        busy={h.busy}
        onSubmit={(organizationId, role, startedOn) => h.onAdd({ personId: c.id, organizationId, role, startedOn })}
      />
    </div>
  );
}

/** An organization's people with their role there, plus the history. */
export function OrganizationPeople(props: {
  contact: DirectoryContact;
  affiliations: readonly DirectoryAffiliation[];
  persons: readonly DirectoryContact[];
  legacyTextOf: (personId: string) => string;
  h: AffiliationHandlers;
}) {
  const { contact: c, h } = props;
  const here = props.affiliations.filter((a) => a.organizationId === c.id);
  const open = here.filter((a) => a.endedOn === null);
  const ended = here.filter((a) => a.endedOn !== null);
  const taken = new Set(open.map((a) => a.personId));
  const choices = props.persons.filter((p) => !taken.has(p.id));
  return (
    <div>
      {open.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Noch keine Person zugeordnet.
        </p>
      ) : (
        <ul className="space-y-2">
          {open.map((a) => (
            <Row key={a.id} a={a} title={a.personName} openId={a.personId} legacyText={props.legacyTextOf(a.personId)} showPrimary={false} h={h} />
          ))}
        </ul>
      )}
      <History rows={ended} title={(a) => a.personName} h={h} />
      <AddForm
        options={choices}
        selectLabel="Person wählen"
        emptyText="Keine weitere Person zum Zuordnen vorhanden."
        submitLabel="Person zuordnen"
        busy={h.busy}
        onSubmit={(personId, role, startedOn) => h.onAdd({ personId, organizationId: c.id, role, startedOn })}
      />
    </div>
  );
}
