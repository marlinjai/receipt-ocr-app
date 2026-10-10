'use client';

import { useCallback, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Contact } from '@/lib/contacts/store';
import type { DirectoryContact } from '@/lib/contacts/directory';
import { contactsTabCount } from '@/lib/contacts/field-form';
import { incompleteQueue } from '@/lib/meals/register';
import { isDismissedMeal } from '@/lib/meals/rules';
import type { MealRecord, MealTaxSettings } from '@/lib/meals/types';
import type { MealsPageData } from './actions';
import ContactsTab from './ContactsTab';
import DirectoryPanel from './DirectoryPanel';
import DismissedMeals from './DismissedMeals';
import QueueTab from './QueueTab';
import RegisterTab from './RegisterTab';

type TabKey = 'queue' | 'register' | 'contacts';

export default function MealsClient({ initial }: { initial: MealsPageData }) {
  const tabsId = useId();
  const [records, setRecords] = useState<MealRecord[]>(initial.records);
  const [contacts, setContacts] = useState<Contact[]>(initial.contacts);
  const [organizationCount, setOrganizationCount] = useState(initial.organizationCount);
  const [settings, setSettings] = useState<MealTaxSettings>(initial.settings);
  const [defaultHost, setDefaultHost] = useState(initial.defaultHost);
  const [tab, setTab] = useState<TabKey>(() => (incompleteQueue(initial.records.filter((r) => !isDismissedMeal(r))).length > 0 ? 'queue' : 'register'));

  // `records` also holds the receipts marked "Keine Bewirtung"; they are listed
  // on their own and never reach the queue, the register or the year picker.
  const mealRecords = useMemo(() => records.filter((r) => !isDismissedMeal(r)), [records]);
  const dismissed = useMemo(() => records.filter(isDismissedMeal), [records]);
  const queue = useMemo(() => incompleteQueue(mealRecords), [mealRecords]);

  const onRecordSaved = useCallback((record: MealRecord) => {
    setRecords((list) => list.map((r) => (r.rowId === record.rowId ? record : r)));
    if (record.host.trim()) setDefaultHost(record.host.trim());
  }, []);

  const onRecordsSaved = useCallback((saved: MealRecord[]) => {
    const byId = new Map(saved.map((r) => [r.rowId, r]));
    setRecords((list) => list.map((r) => byId.get(r.rowId) ?? r));
  }, []);

  const onRecordsRemoved = useCallback((rowIds: string[]) => {
    const gone = new Set(rowIds);
    setRecords((list) => list.filter((r) => !gone.has(r.rowId)));
  }, []);

  const onContactUpserted = useCallback((contact: Contact) => {
    setContacts((list) => {
      const next = list.some((c) => c.id === contact.id)
        ? list.map((c) => (c.id === contact.id ? contact : c))
        : [...list, contact];
      return next.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    });
    // A corrected contact changes how it is printed on existing meals.
    setRecords((list) =>
      list.map((r) =>
        r.guests.some((g) => g.contactId === contact.id)
          ? {
              ...r,
              guests: r.guests.map((g) =>
                g.contactId === contact.id ? { ...g, name: contact.name, company: contact.companyOrRole } : g,
              ),
            }
          : r,
      ),
    );
  }, []);

  // The directory lists organizations too and can erase a person, so the badge
  // and the guest list follow what it shows.
  const onDirectoryChanged = useCallback((listed: DirectoryContact[]) => {
    setOrganizationCount(listed.filter((c) => c.kind === 'organization').length);
    const ids = new Set(listed.map((c) => c.id));
    setContacts((prev) => prev.filter((c) => c.archived || ids.has(c.id)));
  }, []);

  const tabs: Array<{ key: TabKey; label: string; count?: number }> = [
    { key: 'queue', label: 'Unvollständig', count: queue.length },
    { key: 'register', label: 'Verzeichnis' },
    { key: 'contacts', label: 'Kontakte', count: contactsTabCount(contacts, organizationCount) },
  ];

  return (
    <main className="relative z-10 min-h-svh px-4 pb-40 pt-6 sm:px-6" data-theme="dark">
      <div className="mx-auto w-full max-w-[88rem]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold" style={{ color: 'var(--foreground)' }}>
              Bewirtungsverzeichnis
            </h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
              Geschäftliche Bewirtungen mit Teilnehmern und Anlass, zu 70 % abziehbar.
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/app/dashboard" className="ui-btn">
              Dashboard
            </Link>
            <Link href="/app" className="ui-btn ui-btn-primary">
              Beleg hochladen
            </Link>
          </div>
        </div>

        <div role="tablist" aria-label="Bereiche des Bewirtungsverzeichnisses" className="ui-scroll-bare mt-6 flex gap-1 overflow-x-auto overflow-y-hidden border-b" style={{ borderColor: 'var(--border)' }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              type="button"
              id={`${tabsId}-tab-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls={`${tabsId}-panel-${t.key}`}
              onClick={() => setTab(t.key)}
              className="-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors duration-150"
              style={{
                borderColor: tab === t.key ? 'var(--accent)' : 'transparent',
                color: tab === t.key ? 'var(--accent)' : 'var(--muted)',
              }}
            >
              {t.label}
              {t.count !== undefined && (
                <span
                  className="ml-2 rounded-full px-1.5 py-0.5 text-xs tabular-nums"
                  style={{ background: 'rgba(255,255,255,0.07)', color: 'var(--foreground)' }}
                >
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`${tabsId}-panel-${tab}`} aria-labelledby={`${tabsId}-tab-${tab}`} className="mt-6">
          {tab === 'queue' && (
            <QueueTab
              queue={queue}
              contacts={contacts}
              settings={settings}
              defaultHost={defaultHost}
              onRecordSaved={onRecordSaved}
              onRecordsSaved={onRecordsSaved}
              onRecordsRemoved={onRecordsRemoved}
              onContactCreated={onContactUpserted}
              onOpenRegister={() => setTab('register')}
            />
          )}
          {tab === 'register' && (
            <RegisterTab
              records={mealRecords}
              settings={settings}
              onSettingsChanged={setSettings}
              onRecordsSaved={onRecordsSaved}
              onRecordsRemoved={onRecordsRemoved}
              onOpenQueue={() => setTab('queue')}
            />
          )}
          {tab === 'contacts' && (
            <>
              <ContactsTab contacts={contacts} onContactChanged={onContactUpserted} />
              <DirectoryPanel onChanged={onDirectoryChanged} />
            </>
          )}
        </div>

        {tab !== 'contacts' && (
          <DismissedMeals records={dismissed} onRecordsSaved={onRecordsSaved} onRecordsRemoved={onRecordsRemoved} />
        )}
      </div>
    </main>
  );
}
