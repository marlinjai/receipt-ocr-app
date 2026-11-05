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

  // The key changing takes this store away. What it still has to say goes to the desk, with the company's name.
  useEffect(() => {
    if (!desk) return;
    store.stay();
    return () => store.leave((refusal) => desk.take(company, refusal));
  }, [store, desk, company]);

  useEffect(() => {
    let left = false;
    // Only the latest answer counts: an older call finishing last must not overwrite the newer number.
    let asked = 0;
    const ask = () => {
      const mine = ++asked;
      getNavCounts()
        .then((result) => {
          if (!left && mine === asked && result.ok) store.serverCounts(result.value);
        })
        .catch(() => {});
    };
    if (pathname !== DASHBOARD) ask();
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
    return () => {
      left = true;
      stop();
    };
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
