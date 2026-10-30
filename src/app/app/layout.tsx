import { Suspense } from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { auth } from '@/lib/auth';
import { initializeReceiptsTable } from './actions';
import WorkspaceSwitcher from '@/components/WorkspaceSwitcher';
import BrowserRulesImport from '@/components/BrowserRulesImport';
import { PushRenewal, SignOutLink } from './spending/PushSession';
import { sessionWorkspaceId } from '@/lib/auth-workspace';
import AppSidebar from '@/components/nav/AppSidebar';
import { NavCountsProvider } from '@/components/nav/nav-counts';
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
    <NavCountsProvider key={sessionWorkspaceId(session)}>
    <div className="sm:flex">
      <AppSidebar session={session} logoutUrl={auth.logoutUrl()} initialFolded={folded} />
      <div className="min-w-0 flex-1">
      {/*
        The sidebar is the wide layout's navigation; this header is the phone's.
        It wraps instead of pushing the page sideways: the first row holds the
        title and the links, the company switcher a row of its own below. The
        links are 44px tall, so a thumb finds them.
      */}
      <header
        className="relative z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3 sm:hidden"
        style={{ borderColor: 'var(--border, rgba(128,128,128,0.2))' }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
            Receipts
          </span>
        </div>
        <Link
          href="/app/spending"
          className="ml-auto inline-flex min-h-11 items-center whitespace-nowrap px-1 text-xs transition-colors hover:underline"
          style={{ color: 'var(--muted)' }}
        >
          Ausgaben
        </Link>
        <div className="order-last w-full min-w-0">
          <WorkspaceSwitcher session={session} />
        </div>
                <span className="whitespace-nowrap [&>a]:inline-flex [&>a]:min-h-11 [&>a]:items-center [&>a]:px-1">
          <SignOutLink href={auth.logoutUrl()} title={session.email}>
            Abmelden
          </SignOutLink>
        </span>
      </header>
      <BrowserRulesImport />
      <PushRenewal />
      {children}
      </div>
    </div>
    </NavCountsProvider>
  );
}
