'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { getNavCounts, type NavCounts } from '@/app/app/nav-actions';

/**
 * The numbers on the places of the navigation. The layout, and with it this
 * provider, stays while pages change, so the numbers stay on screen. A page that
 * holds a number itself reports it (`useReportNavCounts`), so it changes the
 * moment the page does; every other number is asked for when a page opens, so a
 * change elsewhere is counted on the way out. An answer of the server never
 * touches a number a page on screen holds: it may have left before that change.
 */

const DASHBOARD = '/app/dashboard';

interface NavCountsApi {
  counts: NavCounts | null;
  report: (counts: Partial<NavCounts>) => void;
  /** A page takes these numbers over while it is on screen; the return gives them back. */
  hold: (keys: ReadonlyArray<keyof NavCounts>) => () => void;
}

const NavCountsContext = createContext<NavCountsApi>({ counts: null, report: () => {}, hold: () => () => {} });

const NOTHING: NavCounts = { review: 0, meals: 0 };

export function NavCountsProvider({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<NavCounts | null>(null);
  const held = useRef(new Set<keyof NavCounts>());
  const pathname = usePathname();

  useEffect(() => {
    if (pathname === DASHBOARD) return;
    let left = false;
    getNavCounts()
      .then((result) => {
        // The numbers are help, not a condition for anything: without an answer the last ones stay.
        if (left || !result.ok) return;
        const fresh = result.value;
        setCounts((current) => ({ review: held.current.has('review') && current ? current.review : fresh.review, meals: held.current.has('meals') && current ? current.meals : fresh.meals }));
      })
      .catch(() => {});
    return () => {
      left = true;
    };
  }, [pathname]);

  const report = useCallback((next: Partial<NavCounts>) => setCounts((current) => ({ ...NOTHING, ...current, ...next })), []);
  const hold = useCallback((keys: ReadonlyArray<keyof NavCounts>) => {
    for (const key of keys) held.current.add(key);
    return () => {
      for (const key of keys) held.current.delete(key);
    };
  }, []);
  const value = useMemo(() => ({ counts, report, hold }), [counts, report, hold]);
  return <NavCountsContext.Provider value={value}>{children}</NavCountsContext.Provider>;
}

export function useNavCounts(): NavCounts | null {
  return useContext(NavCountsContext).counts;
}

/** For a page that holds numbers itself: the navigation shows them as they change, and the server's answer leaves them alone. */
export function useReportNavCounts(numbers: Partial<NavCounts>): void {
  const { report, hold } = useContext(NavCountsContext);
  const { review, meals } = numbers;
  const hasReview = review !== undefined;
  const hasMeals = meals !== undefined;
  useEffect(() => hold([...(hasReview ? (['review'] as const) : []), ...(hasMeals ? (['meals'] as const) : [])]), [hold, hasReview, hasMeals]);
  useEffect(() => {
    report({ ...(review !== undefined ? { review } : {}), ...(meals !== undefined ? { meals } : {}) });
  }, [report, review, meals]);
}
