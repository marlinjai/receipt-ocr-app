'use client';

import { observer } from 'mobx-react-lite';
import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { contactsTabCount } from '@/lib/contacts/field-form';
import { MealsStore } from '@/stores/MealsStore';
import { useAppStore } from '@/stores/provider';
import type { MealsPageData } from './actions';
import DismissedMeals from './DismissedMeals';
import QueueTab from './QueueTab';
import RegisterTab from './RegisterTab';
import { useDiscardGuard } from './useDiscardGuard';

type TabKey = 'queue' | 'register';

const MealsClient = observer(function MealsClient({ initial }: { initial: MealsPageData }) {
  const tabsId = useId();
  const app = useAppStore();
  // One store per visit: the server sent fresh data, and the page's numbers follow it in the navigation.
  const [store] = useState(() => new MealsStore(initial, app.mealOutbox));
  useEffect(() => app.openMeals(store), [app, store]);
  const { queue, dismissed, meals, contacts, settings, defaultHost, recordSaved, recordsSaved, contactUpserted, settingsChanged } = store;
  const [tab, setTab] = useState<TabKey>(() => (store.queue.length > 0 ? 'queue' : 'register'));

  // The open tab says which entry has unsaved changes in its form. Switching
  // tabs takes that form away, so it asks first, like everything else that does.
  const [unsavedSubject, setUnsavedSubject] = useState<string | null>(null);
  const { afterDiscard, dialog: discardDialog } = useDiscardGuard(unsavedSubject);
  const openTab = (next: TabKey) => {
    if (next === tab) return;
    afterDiscard(() => {
      setUnsavedSubject(null);
      setTab(next);
    });
  };

  // A link of this page leaves the form just as a tab switch does. With unsaved
  // changes it asks first and navigates only after "verwerfen". A click that
  // opens the link elsewhere (new tab or window) takes nothing away and is left alone.
  const router = useRouter();
  const leaveTo = (href: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (unsavedSubject === null) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    afterDiscard(() => {
      setUnsavedSubject(null);
      router.push(href);
    });
  };

  const heading = useRef<HTMLHeadingElement>(null);
  const tabs: Array<{ key: TabKey; label: string; count?: number }> = [
    { key: 'queue', label: 'Unvollständig', count: queue.length },
    { key: 'register', label: 'Verzeichnis' },
  ];
  // The contacts have their own page; the count follows guests created in a meal form here.
  const contactCount = contactsTabCount(contacts, initial.organizationCount);

  return (
    <main className="relative z-10 min-h-svh px-4 pb-40 pt-6 sm:px-6" data-theme="dark">
      <div className="mx-auto w-full max-w-[88rem]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold outline-none" style={{ color: 'var(--foreground)' }}>
              Bewirtungsverzeichnis
            </h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
              Geschäftliche Bewirtungen mit Teilnehmern und Anlass, zu 70 % abziehbar.
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/app/dashboard" className="ui-btn" onClick={leaveTo('/app/dashboard')}>
              Belege
            </Link>
            <Link href="/app" className="ui-btn ui-btn-primary" onClick={leaveTo('/app')}>
              Beleg hochladen
            </Link>
          </div>
        </div>

        <div className="ui-scroll-bare mt-6 flex gap-1 overflow-x-auto overflow-y-hidden border-b" style={{ borderColor: 'var(--border)' }}>
          <div role="tablist" aria-label="Bereiche des Bewirtungsverzeichnisses" className="flex gap-1">
            {tabs.map((t) => (
              <button
                key={t.key}
                role="tab"
                type="button"
                id={`${tabsId}-tab-${t.key}`}
                aria-selected={tab === t.key}
                aria-controls={`${tabsId}-panel-${t.key}`}
                onClick={() => openTab(t.key)}
                className="-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors duration-150 max-sm:min-h-11"
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
          {/* Not a tab: the contacts moved to their own page, and this is where they used to be. */}
          <Link
            href="/app/contacts"
            onClick={leaveTo('/app/contacts')}
            className="-mb-px ml-auto shrink-0 border-b-2 border-transparent px-3 py-2.5 text-sm font-medium transition-colors duration-150 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
            style={{ color: 'var(--muted)' }}
          >
            Kontakte
            <span className="ml-2 rounded-full px-1.5 py-0.5 text-xs tabular-nums" style={{ background: 'rgba(255,255,255,0.07)', color: 'var(--foreground)' }}>
              {contactCount}
            </span>
          </Link>
        </div>

        <div role="tabpanel" id={`${tabsId}-panel-${tab}`} aria-labelledby={`${tabsId}-tab-${tab}`} className="mt-6">
          {tab === 'queue' && (
            <QueueTab
              queue={queue}
              contacts={contacts}
              settings={settings}
              defaultHost={defaultHost}
              onRecordSaved={recordSaved}
              onRecordsSaved={recordsSaved}
              writes={store}
              focusHome={heading}
              onContactCreated={contactUpserted}
              onOpenRegister={() => openTab('register')}
              onUnsavedChange={setUnsavedSubject}
            />
          )}
          {tab === 'register' && (
            <RegisterTab
              records={meals}
              contacts={contacts}
              settings={settings}
              defaultHost={defaultHost}
              onSettingsChanged={settingsChanged}
              onRecordSaved={recordSaved}
              onContactCreated={contactUpserted}
              onRecordsSaved={recordsSaved}
              writes={store}
              focusHome={heading}
              onOpenQueue={() => openTab('queue')}
              onUnsavedChange={setUnsavedSubject}
            />
          )}
        </div>

        {discardDialog}
        <DismissedMeals records={dismissed} writes={store} focusHome={heading} />
      </div>
    </main>
  );
});

export default MealsClient;
