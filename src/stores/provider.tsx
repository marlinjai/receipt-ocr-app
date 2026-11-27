'use client';

import { reaction } from 'mobx';
import { enableStaticRendering } from 'mobx-react-lite';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { getNavCounts } from '@/app/app/nav-actions';
import { AppStore } from './AppStore';
import { RefusalDesk } from './RefusalDesk';

// On the server a store is only read for one render: nothing should subscribe.
enableStaticRendering(typeof window === 'undefined');

export const AppStoreContext = createContext<AppStore | null>(null);
export const RefusalDeskContext = createContext<RefusalDesk | null>(null);

const DASHBOARD = '/app/dashboard';

/**
 * How long a number of the navigation counts as fresh when the page changes. Counting
 * costs the server as much as the dashboard's review list and the meals register
 * together (1.2 to 3 s per call in production on 2026-11-27), and a server action
 * holds every later one of the page in line behind it. Asked on every page change,
 * it made each click in the navigation wait for that work. A page whose store has
 * the numbers (dashboard, meals) hands them over when it closes, and a meal write
 * that ends elsewhere still asks at once (below).
 */
export const NAV_COUNTS_FRESH_MS = 60_000;

/** Above the provider the company keys, so a refusal outlives the company it belongs to. */
export function RefusalDeskProvider({ children }: { children: ReactNode }) {
  const [desk] = useState(() => new RefusalDesk());
  return <RefusalDeskContext.Provider value={desk}>{children}</RefusalDeskContext.Provider>;
}

/**
 * Holds the app's store under the layout, so it stays while pages change. The
 * layout keys it by company. Every page but the dashboard, whose store has both
 * numbers, asks the server when it opens, so a change elsewhere is counted on the
 * way out. The numbers are help, not a condition: without an answer the last stay.
 */
export function AppStoreProvider({ company, children }: { /** Whose books these are, as a person reads it. */ company: string; children: ReactNode }) {
  const [store] = useState(() => new AppStore());
  const desk = useContext(RefusalDeskContext);
  const pathname = usePathname();
  // When the server was last asked for the numbers; 0 until then and after a failed answer, so the next page asks again.
  // An ask on its way counts as fresh: a second click must not start the same work again.
  const askedAt = useRef(0);
  // Only the latest answer counts: an older call finishing last must not overwrite the newer number.
  const asked = useRef(0);

  // The key changing takes this store away. What it still has to say goes to the desk, with the company's name.
  useEffect(() => {
    if (!desk) return;
    store.stay();
    return () => store.leave((refusal) => desk.take(company, refusal));
  }, [store, desk, company]);

  useEffect(() => {
    // An answer that arrives after the page changed still counts: the next page does not ask while it is fresh.
    // (A store of a company left is thrown away with its key, so a late answer there changes nothing on screen.)
    const ask = () => {
      const mine = ++asked.current;
      const startedAt = Date.now();
      askedAt.current = startedAt;
      store.countsAsked();
      getNavCounts()
        .then((result) => {
          if (mine !== asked.current) return;
          // The receipts page handed over numbers it counted after this ask started (a receipt confirmed there): those are newer.
          if (startedAt < store.countsKnownAt) return;
          if (result.ok) store.serverCounts(result.value);
          else askedAt.current = 0;
        })
        .catch(() => {
          if (mine === asked.current) askedAt.current = 0;
        });
    };
    const known = Math.max(askedAt.current, store.countsKnownAt);
    // Stale by age, or because a page without a store of its own changed them since (an upload).
    if (pathname !== DASHBOARD && (Date.now() - known >= NAV_COUNTS_FRESH_MS || store.countsChangedSince)) ask();
    // A list action of the meals page that ends after the page closed: the number left behind took it for done.
    // On the dashboard the number on screen is its store's, so that is the one to ask.
    const stop = reaction(
      () => store.mealOutbox.settled,
      () => {
        if (store.meals) return;
        if (store.receipts) void store.receipts.askOpenMeals();
        else ask();
      },
    );
    return stop;
  }, [pathname, store]);

  // An answer of the receipt checks or a list action of the meals page shows at once and is sent after that: closing the page now would lose what is queued.
  useEffect(() => {
    const askFirst = (e: BeforeUnloadEvent) => {
      if (store.checkOutbox.writes.length > 0 || store.mealOutbox.writes.length > 0) e.preventDefault();
    };
    window.addEventListener('beforeunload', askFirst);
    return () => window.removeEventListener('beforeunload', askFirst);
  }, [store]);

  return <AppStoreContext.Provider value={store}>{children}</AppStoreContext.Provider>;
}

/** The app's store. Outside the provider (a page drawn alone) a store of its own, so a page never depends on the shell. */
export function useAppStore(): AppStore {
  const store = useContext(AppStoreContext);
  const [alone] = useState(() => (store ? null : new AppStore()));
  return store ?? (alone as AppStore);
}

/**
 * For a finance write whose answer can come after the part of the page that asked
 * for it closed. The returned `refuse` says a refusal there while it is open
 * (`onPage`), and in the shell once it closed (the `FinanceOutbox`), because the
 * person who went elsewhere believes the change went through. `who` names it for
 * the shell, where no row stands beside it.
 */
export function useFinanceRefusal(): (who: string, message: string, onPage: (message: string) => void) => void {
  const app = useAppStore();
  const open = useRef(false);
  useEffect(() => {
    // Set on every mount, so the second mount of the development double run counts as open again.
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  return useCallback((who, message, onPage) => (open.current ? onPage(message) : app.financeOutbox.say(who, message)), [app]);
}
