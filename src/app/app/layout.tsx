import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { auth } from '@/lib/auth';
import { initializeReceiptsTable } from './actions';
import WorkspaceSwitcher from '@/components/WorkspaceSwitcher';
import BrowserRulesImport from '@/components/BrowserRulesImport';
import Refusals from '@/components/Refusals';
import { PushRenewal } from './spending/PushSession';
import { sessionWorkspaceId } from '@/lib/auth-workspace';
import AppSidebar from '@/components/nav/AppSidebar';
import PhoneNav from '@/components/nav/PhoneNav';
import { AppStoreProvider } from '@/stores/provider';
import { NAV_FOLD_COOKIE, NAV_FOLDED } from '@/components/nav/nav-fold';
import { measurePage, timed } from '@/lib/timing';
import AppLoading from './loading';

export const dynamic = 'force-dynamic';

/**
 * The session check and the table setup run inside a Suspense boundary of
 * their own: a loading.tsx never covers the layout beside it, so without this
 * a direct load of an /app page showed nothing while that work ran.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<AppLoading />}>
      <AppShell>{children}</AppShell>
    </Suspense>
  );
}

async function AppShell({ children }: { children: React.ReactNode }) {
  return measurePage('/app layout', () => renderShell(children));
}

async function renderShell(children: React.ReactNode) {
  // The middleware already gates /app/*; this resolves the verified session
  // for the header and redirects defensively if it is somehow absent.
  const session = await timed('auth.session', () => auth.requireSession('/app'));

  // Per-workspace lazy init: ensures the ACTIVE company's Receipts table +
  // full column/view set exists (idempotent, self-healing).
  await timed('init', () => initializeReceiptsTable());

  const folded = (await cookies()).get(NAV_FOLD_COOKIE)?.value === NAV_FOLDED;

  return (
    // The counts belong to one company: another company starts with its own.
    <AppStoreProvider key={sessionWorkspaceId(session)}>
    <div className="sm:flex">
      <AppSidebar session={session} logoutUrl={auth.logoutUrl()} initialFolded={folded} />
      <div className="min-w-0 flex-1">
      {/*
        The sidebar is the wide layout's navigation; the phone's is the bar along the bottom (`PhoneNav`). Up here the
        phone keeps only whose books are on screen, so the page starts in the first thumb's reach.
      */}
      <header className="app-phone-header relative z-20 border-b px-4 py-2 sm:hidden" style={{ borderColor: 'var(--border, rgba(128,128,128,0.2))' }}>
        <WorkspaceSwitcher session={session} hideLabel />
      </header>
      <BrowserRulesImport />
      <PushRenewal />
      <Refusals />
      {children}
      <PhoneNav session={session} logoutUrl={auth.logoutUrl()} />
      </div>
    </div>
    </AppStoreProvider>
  );
}
