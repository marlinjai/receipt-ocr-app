'use client';

import { enableStaticRendering } from 'mobx-react-lite';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getNavCounts, type NavCounts } from '@/app/app/nav-actions';
import { AppStore } from './AppStore';

// On the server a store is only read for one render: nothing should subscribe.
enableStaticRendering(typeof window === 'undefined');

const AppStoreContext = createContext<AppStore | null>(null);

const DASHBOARD = '/app/dashboard';

/**
 * Holds the app's store under the layout, so it stays while pages change. The
 * layout keys it by company. Every page but the dashboard, which reports its own
 * numbers, asks the server when it opens, so a change elsewhere is counted on the
 * way out. The numbers are help, not a condition: without an answer the last stay.
 */
export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new AppStore());
  const pathname = usePathname();

  useEffect(() => {
    if (pathname === DASHBOARD) return;
    let left = false;
    getNavCounts()
      .then((result) => {
        if (!left && result.ok) store.serverCounts(result.value);
      })
      .catch(() => {});
    return () => {
      left = true;
    };
  }, [pathname, store]);

  return <AppStoreContext.Provider value={store}>{children}</AppStoreContext.Provider>;
}

/** The app's store. Outside the provider (a page drawn alone) a store of its own, so a page never depends on the shell. */
export function useAppStore(): AppStore {
  const store = useContext(AppStoreContext);
  const [alone] = useState(() => (store ? null : new AppStore()));
  return store ?? (alone as AppStore);
}

/** For a page that holds numbers of a domain without a store yet: the navigation shows them as they change. */
export function useReportNavCounts(numbers: Partial<NavCounts>): void {
  const store = useAppStore();
  const { review, meals } = numbers;
  useEffect(() => {
    store.report({ ...(review !== undefined ? { review } : {}), ...(meals !== undefined ? { meals } : {}) });
  }, [store, review, meals]);
  useEffect(() => store.stopReporting, [store]);
}
