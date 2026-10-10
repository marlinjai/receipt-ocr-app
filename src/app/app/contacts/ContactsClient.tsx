'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import type { DirectoryContact, DirectoryField, DirectoryKind, ErasePreview } from '@/lib/contacts/directory';
import { KIND_LABELS, contactContext, contactCountLabel, visibleContacts, type KindFilter } from '@/lib/contacts/contact-list';
import { directoryMessage, fieldErrorMessage } from '@/lib/contacts/directory-messages';
import { customFieldPatch, fieldKeyFromLabel } from '@/lib/contacts/field-form';
import { mealActionMessage } from '@/lib/meals/messages';
import { setContactArchived, updateContact } from '../meals/actions';
import {
  archiveFieldAction,
  assignCustomerNumberAction,
  createDirectoryAction,
  createFieldAction,
  eraseDirectoryAction,
  exportDirectoryAction,
  linkPersonAction,
  listDirectoryAction,
  listFieldsAction,
  mergeDirectoryAction,
  previewEraseAction,
  updateDirectoryAction,
} from './actions';
import ContactForm, {
  emptyFormValues,
  formValuesFrom,
  newPersonInput,
  organizationInput,
  personDetailsInput,
  type ContactFormValues,
} from './ContactForm';
import ContactPanel from './ContactPanel';
import ContactTools, { type NewFieldInput } from './ContactTools';

/**
 * The contacts page (/app/contacts): the company's persons and organizations in
 * ONE list, with one place to work on the selected contact. On wide screens that
 * place is a panel beside the list; on narrow screens it takes the list's place.
 *
 * A person is saved through two server actions, as before this page existed:
 * name, company and note go through the guest action of the meal register
 * (`updateContact`), because it also corrects the names printed on existing
 * meals; everything else goes through the directory action. See `saveEdit`.
 */

export interface ContactsPageData {
  /** Every contact of the company, archived ones included: the filters work on this one list. */
  contacts: DirectoryContact[];
  /** Every custom field, archived ones included. */
  fields: DirectoryField[];
}

type TabKey = 'contacts' | 'tools';
type Failure = { ok: false; error: string; field?: string };
type Outcome = { ok: true } | Failure;

const KIND_FILTERS: Array<{ key: KindFilter; label: string }> = [
  { key: 'all', label: 'Alle' },
  { key: 'person', label: 'Personen' },
  { key: 'organization', label: 'Organisationen' },
];

/** Marks a failure whose message the failing step has already shown. */
const SHOWN = 'shown';

/** The guest action answers with the meal register's codes; a refused name belongs under the name input. */
const NAME_ERRORS = new Set(['contact_duplicate', 'contact_invalid', 'duplicate']);

export default function ContactsClient({ initial }: { initial: ContactsPageData }) {
  const uid = useId();
  const [contacts, setContacts] = useState<DirectoryContact[]>(initial.contacts);
  const [fields, setFields] = useState<DirectoryField[]>(initial.fields);
  const [tab, setTab] = useState<TabKey>('contacts');

  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [showArchived, setShowArchived] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  /** Set while a contact is being created. The kind is asked first, so it starts as null. */
  const [creating, setCreating] = useState<{ kind: DirectoryKind | null } | null>(null);
  const [erasing, setErasing] = useState<{ id: string; preview: ErasePreview } | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  const activeFields = useMemo(() => fields.filter((f) => !f.archived), [fields]);
  const selected = useMemo(() => contacts.find((c) => c.id === selectedId) ?? null, [contacts, selectedId]);
  const shown = useMemo(() => visibleContacts(contacts, { kind, query, includeArchived: showArchived }), [contacts, kind, query, showArchived]);
  const activeContacts = useMemo(() => contacts.filter((c) => !c.archived), [contacts]);
  const organizations = useMemo(
    () => activeContacts.filter((c) => c.kind === 'organization').sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [activeContacts],
  );
  const members = useMemo(
    () => (selected?.kind === 'organization' ? contacts.filter((c) => c.kind === 'person' && c.organizationId === selected.id) : []),
    [contacts, selected],
  );
  const archivedCount = contacts.length - activeContacts.length;
  const panelOpen = creating !== null || selected !== null;

  // ---- Focus -------------------------------------------------------------
  // The row a panel was opened from gets the focus back when the panel closes.
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const panelHeadingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  /** Where the focus goes once the next render is on screen (the target may not exist before it). */
  const focusNext = useRef<(() => void) | null>(null);
  const formDirty = useRef(false);

  useEffect(() => {
    const run = focusNext.current;
    focusNext.current = null;
    run?.();
  });

  const focusPanel = () => {
    focusNext.current = () => panelHeadingRef.current?.focus();
  };
  /** Focus a control inside the panel that marks itself with `data-focus`. */
  const focusInPanel = (name: string) => {
    focusNext.current = () => panelRef.current?.querySelector<HTMLElement>(`[data-focus="${name}"]`)?.focus();
  };

  // ---- Loading -----------------------------------------------------------
  // Loads can overlap (a change here while another reload is still running).
  // Only the newest load may be shown, or an older answer would undo a newer one.
  const loadSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++loadSeq.current;
    setReloading(true);
    try {
      const [list, defs] = await Promise.all([listDirectoryAction(true), listFieldsAction()]);
      if (seq !== loadSeq.current) return;
      if (!list.ok || !defs.ok) {
        setLoadError(directoryMessage(!list.ok ? list.error : !defs.ok ? defs.error : 'failed'));
        return;
      }
      setContacts(list.value);
      setFields(defs.value);
      setLoadError(null);
    } catch {
      if (seq === loadSeq.current) setLoadError(directoryMessage('failed'));
    } finally {
      if (seq === loadSeq.current) setReloading(false);
    }
  }, []);

  const clearMessages = () => {
    setError(null);
    setNotice(null);
    setFieldErrors({});
  };

  /** Show a failure: under its input when it names one, otherwise for the form or panel as a whole. */
  const showFailure = (failure: Failure, message: string) => {
    if (failure.field && activeFields.some((f) => f.key === failure.field)) {
      setFieldErrors({ [failure.field]: fieldErrorMessage(failure.error) });
    } else if (NAME_ERRORS.has(failure.error)) {
      setFieldErrors({ name: message });
      return;
    }
    setError(message);
  };

  /** Run one change, then reload the list. */
  const act = async (key: string, run: () => Promise<Outcome>, done?: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(key);
    clearMessages();
    try {
      const result = await run();
      if (!result.ok) {
        // `shown`: the step that failed has already put its own wording on screen.
        if (result.error !== SHOWN) showFailure(result, directoryMessage(result.error));
        // Someone else changed or removed it: fetch the current state, so the next try works on it.
        if (result.error === 'stale' || result.error === 'not_found') await reload();
        return false;
      }
      if (done) setNotice(done);
      await reload();
      return true;
    } catch {
      setError(directoryMessage('failed'));
      return false;
    } finally {
      setBusy(null);
    }
  };

  // ---- Opening and closing ----------------------------------------------
  const openContact = (id: string) => {
    setSelectedId(id);
    setCreating(null);
    setEditing(false);
    setErasing(null);
    formDirty.current = false;
    clearMessages();
    focusPanel();
  };

  const closePanel = () => {
    const from = creating ? null : selectedId;
    setSelectedId(null);
    setCreating(null);
    setEditing(false);
    setErasing(null);
    formDirty.current = false;
    setError(null);
    setFieldErrors({});
    focusNext.current = () => {
      const row = from ? rowRefs.current.get(from) : null;
      (row ?? (from ? listRef.current : createButtonRef.current) ?? listRef.current)?.focus();
    };
  };

  const startCreate = () => {
    setTab('contacts');
    setSelectedId(null);
    setEditing(false);
    setErasing(null);
    setCreating({ kind: null });
    formDirty.current = false;
    clearMessages();
    focusPanel();
  };

  const cancelEdit = () => {
    setEditing(false);
    formDirty.current = false;
    setError(null);
    setFieldErrors({});
    focusPanel();
  };

  const cancelErase = () => {
    setErasing(null);
    focusInPanel('erase');
  };

  /**
   * Escape steps back one level: out of the erase question, out of an untouched
   * form, then out of the panel. A form with changes is never discarded by a key.
   */
  const onPanelKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented || busy) return;
    if (erasing) {
      e.preventDefault();
      cancelErase();
    } else if (editing) {
      if (formDirty.current) return;
      e.preventDefault();
      cancelEdit();
    } else if (creating && formDirty.current) {
      return;
    } else {
      e.preventDefault();
      closePanel();
    }
  };

  // ---- Saving ------------------------------------------------------------
  const invalidFields = (invalid: string[]) => {
    setFieldErrors(Object.fromEntries(invalid.map((k) => [k, fieldErrorMessage('invalid_value')])));
    setError(directoryMessage('invalid_value'));
  };

  const saveNew = (values: ContactFormValues) => {
    const newKind = creating?.kind;
    if (!newKind) return;
    const { patch, invalid } = customFieldPatch(activeFields, values.fields, {});
    if (invalid.length > 0) return invalidFields(invalid);
    const custom = Object.keys(patch).length > 0 ? { customFields: patch } : {};
    const input = newKind === 'organization' ? organizationInput(values) : newPersonInput(values);
    void act(
      'save',
      async () => {
        const r = await createDirectoryAction({ ...input, ...custom, kind: newKind, name: input.name ?? '' });
        if (r.ok) {
          // The new contact is opened, so what was just entered can be checked and continued.
          // It joins the list at once: the panel must not close and reopen while the list reloads.
          setContacts((list) => [...list.filter((c) => c.id !== r.value.id), r.value]);
          setCreating(null);
          setSelectedId(r.value.id);
          formDirty.current = false;
          focusPanel();
        }
        return r;
      },
      newKind === 'organization' ? 'Organisation angelegt.' : 'Person angelegt.',
    );
  };

  const saveEdit = (values: ContactFormValues) => {
    const contact = selected;
    if (!contact) return;
    const { patch, invalid } = customFieldPatch(activeFields, values.fields, contact.customFields);
    if (invalid.length > 0) return invalidFields(invalid);
    const custom = Object.keys(patch).length > 0 ? { customFields: patch } : {};
    const finish = () => {
      setEditing(false);
      formDirty.current = false;
      focusPanel();
    };

    if (contact.kind === 'organization') {
      void act(
        'save',
        async () => {
          const r = await updateDirectoryAction(contact.id, { ...organizationInput(values), ...custom }, contact.version);
          if (r.ok) finish();
          return r;
        },
        'Änderungen gespeichert.',
      );
      return;
    }

    // A person: two actions, each called only when its part changed.
    const details = personDetailsInput(values);
    const detailsChanged =
      details.email !== contact.email ||
      details.phone !== contact.phone ||
      details.preferredContact !== contact.preferredContact ||
      Object.keys(patch).length > 0;
    const name = values.name.replace(/\s+/g, ' ').trim();
    const companyOrRole = values.companyOrRole.replace(/\s+/g, ' ').trim();
    const note = values.note.trim() || null;
    const identityChanged = name !== contact.name || companyOrRole !== contact.companyOrRole || note !== (contact.note ?? null);

    if (!detailsChanged && !identityChanged) {
      clearMessages();
      finish();
      return;
    }

    void act(
      'save',
      async () => {
        // The directory action first: it checks the version this form was opened with.
        // The guest action reads the record itself, so it works on the result of the first.
        if (detailsChanged) {
          const r = await updateDirectoryAction(contact.id, { ...details, ...custom }, contact.version);
          if (!r.ok) return r;
        }
        if (identityChanged) {
          const r = await updateContact(contact.id, { name, companyOrRole, note });
          if (!r.ok) {
            // The first half may be saved already: show the list as it is now, with the form still open.
            if (detailsChanged) await reload();
            const message = mealActionMessage(r.error, r.detail);
            if (NAME_ERRORS.has(r.error)) setFieldErrors({ name: message });
            else setError(message);
            return { ok: false, error: SHOWN } as const;
          }
        }
        finish();
        return { ok: true } as const;
      },
      'Änderungen gespeichert.',
    );
  };

  const toggleArchived = () => {
    const contact = selected;
    if (!contact || contact.kind !== 'person' || busy) return;
    setBusy('archive');
    clearMessages();
    void (async () => {
      try {
        const r = await setContactArchived(contact.id, !contact.archived);
        if (!r.ok) {
          setError(mealActionMessage(r.error, r.detail));
          return;
        }
        setNotice(contact.archived ? 'Kontakt wiederhergestellt.' : 'Kontakt archiviert. Er bleibt hier geöffnet und lässt sich wiederherstellen.');
        await reload();
      } catch {
        setError(mealActionMessage('failed'));
      } finally {
        setBusy(null);
      }
    })();
  };

  const exportOne = async () => {
    const contact = selected;
    if (!contact || busy) return;
    setBusy('export');
    clearMessages();
    try {
      const r = await exportDirectoryAction(contact.id);
      if (!r.ok) {
        setError(directoryMessage(r.error));
        return;
      }
      const url = URL.createObjectURL(new Blob([r.value], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `kontakt-${contact.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(directoryMessage('failed'));
    } finally {
      setBusy(null);
    }
  };

  /** Ask what erasing would do before anything is deleted. */
  const askErase = async () => {
    const contact = selected;
    if (!contact || busy) return;
    setBusy('preview');
    clearMessages();
    try {
      const r = await previewEraseAction(contact.id);
      if (!r.ok) {
        setError(directoryMessage(r.error));
        return;
      }
      setErasing({ id: contact.id, preview: r.value });
      setEditing(false);
      focusInPanel('erase-cancel');
    } catch {
      setError(directoryMessage('failed'));
    } finally {
      setBusy(null);
    }
  };

  const confirmErase = () => {
    if (!erasing) return;
    const { id } = erasing;
    void act('erase', async () => {
      const r = await eraseDirectoryAction(id);
      if (r.ok) {
        setErasing(null);
        setSelectedId(null);
        setNotice(r.value.outcome === 'erased' ? 'Kontakt gelöscht.' : 'Dieser Kontakt war bereits gelöscht.');
        focusNext.current = () => listRef.current?.focus();
      }
      return r;
    });
  };

  const merge = (loserId: string, winnerId: string) =>
    act('merge', async () => {
      const r = await mergeDirectoryAction(loserId, winnerId);
      if (r.ok) {
        setNotice(r.value.outcome === 'merged' ? 'Zusammengeführt.' : 'Bereits zusammengeführt.');
        if (selectedId === loserId) setSelectedId(null);
      }
      return r;
    });

  const createField = (input: NewFieldInput) =>
    act('field-new', () => createFieldAction({ key: fieldKeyFromLabel(input.label), label: input.label, type: input.type, options: input.options }), 'Feld angelegt.');

  const resetFilters = () => {
    setQuery('');
    setKind('all');
  };

  // ---- Rendering ---------------------------------------------------------
  const tabs: Array<{ key: TabKey; label: string; count?: number }> = [
    { key: 'contacts', label: 'Kontakte', count: activeContacts.length },
    { key: 'tools', label: 'Verwaltung' },
  ];
  const filtered = query.trim() !== '' || kind !== 'all';
  const panelTitle = creating ? 'Kontakt anlegen' : (selected?.name ?? '');
  const formError = error;

  return (
    <main className="relative z-10 min-h-svh px-4 pb-24 pt-6 sm:px-6" data-theme="dark">
      <div className="mx-auto w-full max-w-[88rem]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold" style={{ color: 'var(--foreground)' }}>
              Kontakte
            </h1>
            <p className="mt-1 max-w-2xl text-sm" style={{ color: 'var(--muted)' }}>
              Die Personen und Organisationen dieses Kontos. Personen lassen sich als Teilnehmer einer Bewirtung auswählen.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/app/dashboard" className="ui-btn">
              Dashboard
            </Link>
            <Link href="/app/meals" className="ui-btn">
              Bewirtungen
            </Link>
            <button ref={createButtonRef} type="button" className="ui-btn ui-btn-primary" onClick={startCreate}>
              Kontakt anlegen
            </button>
          </div>
        </div>

        <div role="tablist" aria-label="Bereiche der Kontakte" className="ui-scroll-bare mt-6 flex gap-1 overflow-x-auto overflow-y-hidden border-b" style={{ borderColor: 'var(--border)' }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              type="button"
              id={`${uid}-tab-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls={`${uid}-panel-${t.key}`}
              onClick={() => {
                setTab(t.key);
                clearMessages();
              }}
              className="ui-tab -mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium"
              style={{ borderColor: tab === t.key ? 'var(--accent)' : 'transparent', color: tab === t.key ? 'var(--accent)' : 'var(--muted)' }}
            >
              {t.label}
              {t.count !== undefined && (
                <span className="ml-2 rounded-full px-1.5 py-0.5 text-xs tabular-nums" style={{ background: 'rgba(255,255,255,0.07)', color: 'var(--foreground)' }}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-2">
          {loadError && (
            <div role="alert" className="ui-note ui-note-danger flex flex-wrap items-center justify-between gap-3">
              <span>Die Kontakte konnten nicht neu geladen werden; die Liste zeigt den letzten bekannten Stand. {loadError}</span>
              <button type="button" className="ui-btn ui-btn-sm" onClick={() => void reload()}>
                {reloading ? 'Wird geladen…' : 'Erneut laden'}
              </button>
            </div>
          )}
          {notice && (
            <p role="status" className="ui-note ui-note-ok">
              {notice}
            </p>
          )}
          {error && !(tab === 'contacts' && panelOpen) && (
            <p role="alert" className="ui-note ui-note-danger">
              {error}
            </p>
          )}
        </div>

        <div role="tabpanel" id={`${uid}-panel-${tab}`} aria-labelledby={`${uid}-tab-${tab}`} className="mt-4">
          {tab === 'tools' && (
            <ContactTools
              contacts={[...activeContacts].sort((a, b) => a.name.localeCompare(b.name, 'de'))}
              fields={fields}
              busy={busy}
              onMerge={merge}
              onCreateField={createField}
              onArchiveField={(key) => void act(`field-${key}`, () => archiveFieldAction(key), 'Feld archiviert.')}
            />
          )}

          {tab === 'contacts' && (
            <div className={panelOpen ? 'grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:items-start' : ''}>
              {/* On narrow screens the open contact takes the place of the list. */}
              <div className={panelOpen ? 'hidden lg:block' : ''}>
                {contacts.length > 0 && (
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="block min-w-0 flex-1" style={{ flexBasis: '16rem' }}>
                      <span className="ui-label">Suche</span>
                      <input
                        type="search"
                        className="ui-input"
                        placeholder="Name, Organisation, Ort oder Kundennummer"
                        value={query}
                        autoComplete="off"
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </label>
                    <div className="ui-seg" role="group" aria-label="Art der Kontakte">
                      {KIND_FILTERS.map((f) => (
                        <button key={f.key} type="button" aria-pressed={kind === f.key} onClick={() => setKind(f.key)}>
                          {f.label}
                        </button>
                      ))}
                    </div>
                    {archivedCount > 0 && (
                      <div className="ui-seg">
                        <button type="button" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
                          Archivierte anzeigen ({archivedCount})
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div ref={listRef} tabIndex={-1} className="ui-list-region mt-4" aria-busy={reloading}>
                  {contacts.length === 0 ? (
                    <div className="glass-panel rounded-xl p-8 text-center">
                      <p className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                        Noch keine Kontakte
                      </p>
                      <p className="mx-auto mt-1 max-w-md text-sm" style={{ color: 'var(--muted)' }}>
                        Hier stehen die Personen und Organisationen, sobald die erste angelegt ist. Personen entstehen auch direkt beim Erfassen einer Bewirtung, wenn dort ein neuer Name eingetippt wird.
                      </p>
                      <button type="button" className="ui-btn ui-btn-primary mt-4" onClick={startCreate}>
                        Kontakt anlegen
                      </button>
                    </div>
                  ) : shown.length === 0 ? (
                    <div className="glass-panel rounded-xl p-8 text-center">
                      <p className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                        {filtered ? 'Nichts gefunden' : 'Alle Kontakte sind archiviert'}
                      </p>
                      <p className="mx-auto mt-1 max-w-md text-sm" style={{ color: 'var(--muted)' }}>
                        {filtered
                          ? `Zu dieser Suche und Auswahl gibt es keinen Kontakt${!showArchived && archivedCount > 0 ? ' unter den aktiven. Vielleicht ist er archiviert.' : '.'}`
                          : 'Archivierte Kontakte werden bei neuen Bewirtungen nicht vorgeschlagen.'}
                      </p>
                      <div className="mt-4 flex flex-wrap justify-center gap-2">
                        {filtered && (
                          <button type="button" className="ui-btn" onClick={resetFilters}>
                            Suche zurücksetzen
                          </button>
                        )}
                        {!showArchived && archivedCount > 0 && (
                          <button type="button" className="ui-btn" onClick={() => setShowArchived(true)}>
                            Archivierte anzeigen
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="mb-2 text-xs" aria-live="polite" style={{ color: 'var(--muted)' }}>
                        {contactCountLabel(shown.length)}
                      </p>
                      <ul className="space-y-1.5" aria-label="Kontakte">
                        {shown.map((c) => {
                          const context = contactContext(c);
                          const isOpen = !creating && selectedId === c.id;
                          return (
                            <li key={c.id}>
                              <button
                                type="button"
                                ref={(el) => {
                                  if (el) rowRefs.current.set(c.id, el);
                                  else rowRefs.current.delete(c.id);
                                }}
                                className="ui-list-row"
                                aria-current={isOpen ? 'true' : undefined}
                                onClick={() => openContact(c.id)}
                              >
                                <span className="flex min-w-0 items-baseline gap-2">
                                  <span className="truncate text-sm font-medium" style={{ color: c.archived ? 'var(--muted)' : 'var(--foreground)' }}>
                                    {c.name}
                                  </span>
                                  <span className="shrink-0 text-xs" style={{ color: 'var(--muted)' }}>
                                    {KIND_LABELS[c.kind]}
                                    {c.archived ? ', archiviert' : ''}
                                  </span>
                                </span>
                                {(context || c.customerNumber) && (
                                  <span className="flex min-w-0 items-baseline justify-between gap-3 text-xs" style={{ color: 'var(--muted)' }}>
                                    <span className="truncate">{context}</span>
                                    {c.customerNumber && <span className="shrink-0 tabular-nums">Kundennummer {c.customerNumber}</span>}
                                  </span>
                                )}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                </div>
              </div>

              {panelOpen && (
                <section
                  ref={panelRef}
                  className="ui-panel-in glass-panel rounded-xl p-4 sm:p-5 lg:sticky lg:top-4 lg:max-h-[calc(100svh-2rem)] lg:overflow-y-auto"
                  aria-labelledby={`${uid}-panel-title`}
                  onKeyDown={onPanelKeyDown}
                >
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 id={`${uid}-panel-title`} ref={panelHeadingRef} tabIndex={-1} className="ui-panel-title break-words text-lg font-semibold" style={{ color: 'var(--foreground)' }}>
                        {panelTitle}
                      </h2>
                      {selected && !creating && (
                        <p className="text-xs" style={{ color: 'var(--muted)' }}>
                          {KIND_LABELS[selected.kind]}
                          {contactContext(selected) ? ` · ${contactContext(selected)}` : ''}
                        </p>
                      )}
                    </div>
                    <button type="button" className="ui-btn ui-btn-sm shrink-0" onClick={closePanel} disabled={busy !== null}>
                      <span className="lg:hidden">Zurück zur Liste</span>
                      <span className="hidden lg:inline">Schließen</span>
                    </button>
                  </div>

                  {creating && (
                    <div className="space-y-4">
                      <div>
                        <p id={`${uid}-kind`} className="ui-label">
                          Was soll angelegt werden?
                        </p>
                        <div className="ui-seg" role="group" aria-labelledby={`${uid}-kind`}>
                          {(['person', 'organization'] as const).map((k) => (
                            <button
                              key={k}
                              type="button"
                              aria-pressed={creating.kind === k}
                              disabled={busy !== null}
                              onClick={() => {
                                setCreating({ kind: k });
                                setError(null);
                                setFieldErrors({});
                              }}
                            >
                              {KIND_LABELS[k]}
                            </button>
                          ))}
                        </div>
                        {creating.kind === null && (
                          <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
                            Eine Person kann Teilnehmer einer Bewirtung sein. Eine Organisation hat Anschrift und Umsatzsteuer-ID, und Personen lassen sich ihr zuordnen.
                          </p>
                        )}
                      </div>
                      {creating.kind !== null && (
                        // One form for both kinds: changing the kind keeps what was already typed.
                        <ContactForm
                          kind={creating.kind}
                          mode="create"
                          initial={emptyFormValues(activeFields)}
                          fields={activeFields}
                          label={creating.kind === 'organization' ? 'Neue Organisation' : 'Neue Person'}
                          saving={busy === 'save'}
                          disabled={busy !== null}
                          error={formError}
                          fieldErrors={fieldErrors}
                          onSubmit={saveNew}
                          onCancel={closePanel}
                          onDirtyChange={(dirty) => {
                            formDirty.current = dirty;
                          }}
                        />
                      )}
                    </div>
                  )}

                  {selected && !creating && editing && (
                    <ContactForm
                      key={selected.id}
                      kind={selected.kind}
                      mode="edit"
                      initial={formValuesFrom(selected, activeFields)}
                      fields={activeFields}
                      label={selected.kind === 'organization' ? 'Organisation bearbeiten' : 'Person bearbeiten'}
                      saving={busy === 'save'}
                      disabled={busy !== null}
                      error={formError}
                      fieldErrors={fieldErrors}
                      onSubmit={saveEdit}
                      onCancel={cancelEdit}
                      onDirtyChange={(dirty) => {
                        formDirty.current = dirty;
                      }}
                    />
                  )}

                  {selected && !creating && !editing && (
                    <>
                      {error && (
                        <p role="alert" className="ui-note ui-note-danger mb-4">
                          {error}
                        </p>
                      )}
                      <ContactPanel
                        contact={selected}
                        fields={activeFields}
                        organizations={organizations}
                        members={members}
                        busy={busy}
                        erasePreview={erasing?.id === selected.id ? erasing.preview : null}
                        onEdit={() => {
                          setEditing(true);
                          setErasing(null);
                          formDirty.current = false;
                          clearMessages();
                          focusPanel();
                        }}
                        onLink={(organizationId) => void act('link', () => linkPersonAction(selected.id, organizationId, selected.version), 'Verknüpfung gespeichert.')}
                        onAssignNumber={() => void act('number', () => assignCustomerNumberAction(selected.id), 'Kundennummer vergeben.')}
                        onExport={() => void exportOne()}
                        onToggleArchived={toggleArchived}
                        onAskErase={() => void askErase()}
                        onConfirmErase={confirmErase}
                        onCancelErase={cancelErase}
                        onOpenContact={openContact}
                      />
                    </>
                  )}
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
