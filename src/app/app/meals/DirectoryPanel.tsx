'use client';

import { useEffect, useState } from 'react';
import type { DirectoryContact, DirectoryInput } from '@/lib/contacts/directory';
import { directoryMessage } from '@/lib/contacts/directory-messages';
import {
  assignCustomerNumberAction,
  createDirectoryAction,
  eraseDirectoryAction,
  exportDirectoryAction,
  linkPersonAction,
  listDirectoryAction,
  mergeDirectoryAction,
  updateDirectoryAction,
} from './directory-actions';

/**
 * The directory of persons and organizations (wave 3, docs/plans/2026-10-09-contact-screen.md).
 * Organizations get their address, legal form and VAT ID here. Persons are linked to an
 * organization, merged, numbered and exported one at a time. Custom fields and the preferred
 * contact method are not here yet: they wait for the contacts package release 0.2.0.
 */

type Editing = { mode: 'create' } | { mode: 'edit'; contact: DirectoryContact };

interface OrgForm {
  name: string;
  legalForm: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  country: string;
  vatId: string;
  email: string;
  phone: string;
  note: string;
}

const EMPTY_FORM: OrgForm = {
  name: '',
  legalForm: '',
  addressLine1: '',
  addressLine2: '',
  postalCode: '',
  city: '',
  country: '',
  vatId: '',
  email: '',
  phone: '',
  note: '',
};

const blank = (v: string) => (v.trim() === '' ? null : v.trim());

function formFrom(c: DirectoryContact): OrgForm {
  return {
    name: c.name,
    legalForm: c.legalForm ?? '',
    addressLine1: c.addressLine1 ?? '',
    addressLine2: c.addressLine2 ?? '',
    postalCode: c.postalCode ?? '',
    city: c.city ?? '',
    country: c.country ?? '',
    vatId: c.vatId ?? '',
    email: c.email ?? '',
    phone: c.phone ?? '',
    note: c.note ?? '',
  };
}

function inputFrom(form: OrgForm): DirectoryInput {
  return {
    name: form.name.trim(),
    legalForm: blank(form.legalForm),
    addressLine1: blank(form.addressLine1),
    addressLine2: blank(form.addressLine2),
    postalCode: blank(form.postalCode),
    city: blank(form.city),
    country: blank(form.country)?.toUpperCase() ?? null,
    vatId: blank(form.vatId),
    email: blank(form.email),
    phone: blank(form.phone),
    note: blank(form.note),
  };
}

export default function DirectoryPanel() {
  const [contacts, setContacts] = useState<DirectoryContact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [form, setForm] = useState<OrgForm>(EMPTY_FORM);
  const [linkTarget, setLinkTarget] = useState<Record<string, string>>({});
  const [mergeLoser, setMergeLoser] = useState('');
  const [mergeWinner, setMergeWinner] = useState('');
  const [confirmErase, setConfirmErase] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = async () => {
    const result = await listDirectoryAction(false);
    if (result.ok) setContacts(result.value);
    else setError(directoryMessage(result.error));
  };

  useEffect(() => {
    void reload();
  }, []);

  /** Run one change, then reload the list. Shows the message on failure. */
  const act = async (key: string, run: () => Promise<{ ok: true } | { ok: false; error: string }>, done?: string) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const result = await run();
      if (!result.ok) {
        setError(directoryMessage(result.error));
        return;
      }
      if (done) setNotice(done);
      await reload();
    } catch {
      setError(directoryMessage('failed'));
    } finally {
      setBusy(null);
    }
  };

  const saveOrganization = () => {
    if (!editing) return;
    const input = inputFrom(form);
    if (editing.mode === 'create') {
      void act('save', async () => {
        const r = await createDirectoryAction({ ...input, kind: 'organization', name: input.name ?? '' });
        if (r.ok) setEditing(null);
        return r;
      }, 'Organisation angelegt.');
    } else {
      const { contact } = editing;
      void act('save', async () => {
        const r = await updateDirectoryAction(contact.id, input, contact.version);
        if (r.ok) setEditing(null);
        return r;
      }, 'Änderungen gespeichert.');
    }
  };

  const exportOne = async (c: DirectoryContact) => {
    setBusy(`export-${c.id}`);
    setError(null);
    try {
      const r = await exportDirectoryAction(c.id);
      if (!r.ok) {
        setError(directoryMessage(r.error));
        return;
      }
      const url = URL.createObjectURL(new Blob([r.value], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `kontakt-${c.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(null);
    }
  };

  const organizations = (contacts ?? []).filter((c) => c.kind === 'organization');
  const people = (contacts ?? []).filter((c) => c.kind === 'person');

  return (
    <section className="mt-8 space-y-4" aria-labelledby="directory-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="directory-heading" className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
          Verzeichnis
        </h2>
        <button
          type="button"
          className="ui-btn ui-btn-primary ui-btn-sm"
          onClick={() => { setEditing({ mode: 'create' }); setForm(EMPTY_FORM); setError(null); setNotice(null); }}
        >
          Organisation anlegen
        </button>
      </div>

      {error && <p role="alert" className="ui-note ui-note-danger">{error}</p>}
      {notice && <p role="status" className="ui-note">{notice}</p>}

      {editing && (
        <form
          className="glass-panel space-y-3 rounded-xl p-4"
          aria-label={editing.mode === 'create' ? 'Neue Organisation' : 'Organisation bearbeiten'}
          onSubmit={(e) => { e.preventDefault(); saveOrganization(); }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <OrgField id="org-name" label="Name" value={form.name} required onChange={(v) => setForm({ ...form, name: v })} />
            <OrgField id="org-legal" label="Rechtsform (z. B. GmbH, Einzelunternehmen)" value={form.legalForm} onChange={(v) => setForm({ ...form, legalForm: v })} />
            <OrgField id="org-street1" label="Straße und Hausnummer" value={form.addressLine1} onChange={(v) => setForm({ ...form, addressLine1: v })} />
            <OrgField id="org-street2" label="Adresszusatz" value={form.addressLine2} onChange={(v) => setForm({ ...form, addressLine2: v })} />
            <OrgField id="org-zip" label="Postleitzahl" value={form.postalCode} onChange={(v) => setForm({ ...form, postalCode: v })} />
            <OrgField id="org-city" label="Ort" value={form.city} onChange={(v) => setForm({ ...form, city: v })} />
            <OrgField id="org-country" label="Land (Zwei-Buchstaben-Code, z. B. DE)" value={form.country} maxLength={2} onChange={(v) => setForm({ ...form, country: v })} />
            <OrgField id="org-vat" label="Umsatzsteuer-ID" value={form.vatId} onChange={(v) => setForm({ ...form, vatId: v })} />
            <OrgField id="org-email" label="E-Mail" value={form.email} type="email" onChange={(v) => setForm({ ...form, email: v })} />
            <OrgField id="org-phone" label="Telefon" value={form.phone} type="tel" onChange={(v) => setForm({ ...form, phone: v })} />
          </div>
          <OrgField id="org-note" label="Notiz (wird nicht gedruckt)" value={form.note} onChange={(v) => setForm({ ...form, note: v })} />
          <div className="flex gap-2">
            <button type="submit" className="ui-btn ui-btn-primary" disabled={Boolean(busy) || !form.name.trim()}>
              {busy === 'save' ? 'Wird gespeichert…' : 'Speichern'}
            </button>
            <button type="button" className="ui-btn" onClick={() => setEditing(null)} disabled={Boolean(busy)}>
              Abbrechen
            </button>
          </div>
        </form>
      )}

      {contacts === null ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Wird geladen…</p>
      ) : contacts.length === 0 ? (
        <p className="glass-panel rounded-xl p-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
          Noch keine Organisationen oder Personen im Verzeichnis.
        </p>
      ) : (
        <ul className="space-y-2">
          {[...organizations, ...people].map((c) => (
            <li key={c.id} className="glass-panel rounded-xl px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                    {c.name}
                    <span className="ml-2 text-xs font-normal" style={{ color: 'var(--muted)' }}>
                      {c.kind === 'organization' ? 'Organisation' : 'Person'}
                    </span>
                  </p>
                  <p className="truncate text-xs" style={{ color: 'var(--muted)' }}>
                    {c.kind === 'organization'
                      ? [c.legalForm, [c.postalCode, c.city].filter(Boolean).join(' '), c.country].filter(Boolean).join(' · ') || 'Keine Adresse hinterlegt'
                      : c.organizationName
                        ? `Bei ${c.organizationName}`
                        : c.companyOrRole || 'Keine Organisation verknüpft'}
                    {c.customerNumber && ` · Kundennummer ${c.customerNumber}`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {c.kind === 'organization' && (
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm"
                      disabled={Boolean(busy)}
                      onClick={() => { setEditing({ mode: 'edit', contact: c }); setForm(formFrom(c)); setError(null); setNotice(null); }}
                    >
                      Bearbeiten
                    </button>
                  )}
                  {c.kind === 'person' && organizations.length > 0 && (
                    <>
                      <label className="sr-only" htmlFor={`link-${c.id}`}>Organisation für {c.name}</label>
                      <select
                        id={`link-${c.id}`}
                        className="ui-input ui-btn-sm"
                        value={linkTarget[c.id] ?? c.organizationId ?? ''}
                        onChange={(e) => setLinkTarget({ ...linkTarget, [c.id]: e.target.value })}
                        disabled={Boolean(busy)}
                      >
                        <option value="">Keine Organisation</option>
                        {organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                      <button
                        type="button"
                        className="ui-btn ui-btn-sm"
                        disabled={Boolean(busy) || (linkTarget[c.id] ?? c.organizationId ?? '') === (c.organizationId ?? '')}
                        onClick={() => {
                          const target = (linkTarget[c.id] ?? '') || null;
                          void act(`link-${c.id}`, () => linkPersonAction(c.id, target, c.version), 'Verknüpfung gespeichert.');
                        }}
                      >
                        Verknüpfen
                      </button>
                    </>
                  )}
                  {c.customerNumber === null && (
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm"
                      disabled={Boolean(busy)}
                      onClick={() => void act(`number-${c.id}`, () => assignCustomerNumberAction(c.id), 'Kundennummer vergeben.')}
                    >
                      Kundennummer vergeben
                    </button>
                  )}
                  <button type="button" className="ui-btn ui-btn-sm" disabled={Boolean(busy)} onClick={() => void exportOne(c)}>
                    Exportieren
                  </button>
                  {confirmErase === c.id ? (
                    <>
                      <button
                        type="button"
                        className="ui-btn ui-btn-sm"
                        disabled={Boolean(busy)}
                        onClick={() => void act(`erase-${c.id}`, () => eraseDirectoryAction())}
                      >
                        Endgültig löschen
                      </button>
                      <button type="button" className="ui-btn ui-btn-sm" onClick={() => setConfirmErase(null)}>
                        Abbrechen
                      </button>
                    </>
                  ) : (
                    <button type="button" className="ui-btn ui-btn-sm" disabled={Boolean(busy)} onClick={() => setConfirmErase(c.id)}>
                      Löschen
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {contacts && contacts.length >= 2 && (
        <fieldset className="glass-panel space-y-3 rounded-xl p-4">
          <legend className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Zwei Kontakte zusammenführen</legend>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Der zu entfernende Kontakt wird im anderen aufgehen. Gedruckte Namen auf bestehenden Bewirtungen bleiben unverändert.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="ui-label">Wird entfernt</span>
              <select className="ui-input" value={mergeLoser} onChange={(e) => setMergeLoser(e.target.value)}>
                <option value="">Bitte wählen</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="ui-label">Bleibt bestehen</span>
              <select className="ui-input" value={mergeWinner} onChange={(e) => setMergeWinner(e.target.value)}>
                <option value="">Bitte wählen</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          </div>
          <button
            type="button"
            className="ui-btn ui-btn-sm"
            disabled={Boolean(busy) || !mergeLoser || !mergeWinner || mergeLoser === mergeWinner}
            onClick={() =>
              void act('merge', async () => {
                const r = await mergeDirectoryAction(mergeLoser, mergeWinner);
                if (r.ok) { setMergeLoser(''); setMergeWinner(''); setNotice(r.value.outcome === 'merged' ? 'Zusammengeführt.' : 'Bereits zusammengeführt.'); }
                return r;
              })
            }
          >
            Zusammenführen
          </button>
        </fieldset>
      )}
    </section>
  );
}

function OrgField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  maxLength?: number;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="ui-label">{props.label}</span>
      <input
        id={props.id}
        className="ui-input"
        value={props.value}
        required={props.required}
        maxLength={props.maxLength}
        type={props.type ?? 'text'}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

