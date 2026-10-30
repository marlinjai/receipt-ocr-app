'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { getNavCounts, type NavCounts } from '@/app/app/nav-actions';

/**
 * The numbers on the sidebar's places. The layout, and with it this provider,
 * stays while pages change, so the numbers stay on screen. The dashboard has
 * both numbers anyway and reports them; every other page asks once when it
 * opens, so a meal completed on its page is counted on the way out.
 */

const DASHBOARD = '/app/dashboard';

const NavCountsContext = createContext<{ counts: NavCounts | null; report: (counts: NavCounts) => void }>({
  counts: null,
  report: () => {},
});

export function NavCountsProvider({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<NavCounts | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    if (pathname === DASHBOARD) return;
    let left = false;
    getNavCounts()
      .then((result) => {
        // The numbers are help, not a condition for anything: without an answer the last ones stay.
        if (!left && result.ok) setCounts(result.value);
      })
      .catch(() => {});
    return () => {
      left = true;
    };
  }, [pathname]);

  const value = useMemo(() => ({ counts, report: setCounts }), [counts]);
  return <NavCountsContext.Provider value={value}>{children}</NavCountsContext.Provider>;
}

export function useNavCounts(): NavCounts | null {
  return useContext(NavCountsContext).counts;
}

/** For the page that holds the numbers itself: the sidebar shows them as they change. */
export function useReportNavCounts({ review, meals }: NavCounts): void {
  const { report } = useContext(NavCountsContext);
  useEffect(() => {
    report({ review, meals });
  }, [report, review, meals]);
}
