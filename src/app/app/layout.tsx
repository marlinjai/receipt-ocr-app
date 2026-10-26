import { Suspense } from 'react';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { initializeReceiptsTable } from './actions';
import WorkspaceSwitcher from '@/components/WorkspaceSwitcher';
import BrowserRulesImport from '@/components/BrowserRulesImport';
import { PushRenewal, SignOutLink } from './spending/PushSession';
import { workspaceLabel } from '@/lib/auth-workspace';
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
  // The middleware already gates /app/*; this resolves the verified session
  // for the header and redirects defensively if it is somehow absent.
  const session = await auth.requireSession('/app');

  // Per-workspace lazy init: ensures the ACTIVE company's Receipts table +
  // full column/view set exists (idempotent, self-healing).
  await initializeReceiptsTable();

  const active = session.activeWorkspace;

  return (
    <>
      {/*
        On a phone the header wraps instead of pushing the page sideways: the
        first row holds the title and the links, the company switcher takes a
        row of its own below. The company chip is left out there, because the
        switcher right below names the same company. From the small breakpoint
        on, everything stands in one row as before. The two links are 44px tall
        on a phone, so a thumb finds them.
      */}
      <header
        className="relative z-20 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 border-b sm:px-6"
        style={{ borderColor: 'var(--border, rgba(128,128,128,0.2))' }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
            Receipts
          </span>
          {active && (
            <span
              className="hidden max-w-[16rem] truncate px-2.5 py-1 rounded-full text-xs font-semibold uppercase tracking-wide sm:inline-block"
              style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
            >
              {active.tenantName || workspaceLabel(active.slug)}
            </span>
          )}
        </div>
        <Link
          href="/app/spending"
          className="ml-auto whitespace-nowrap text-xs transition-colors hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:px-1"
          style={{ color: 'var(--muted)' }}
        >
          Ausgaben
        </Link>
        <div className="order-last w-full min-w-0 sm:order-none sm:w-auto">
          <WorkspaceSwitcher session={session} />
        </div>
        {/* On a phone both header links are 44px touch targets (the link itself lives with the push session code). */}
        <span className="whitespace-nowrap max-sm:[&>a]:inline-flex max-sm:[&>a]:min-h-11 max-sm:[&>a]:items-center max-sm:[&>a]:px-1">
          <SignOutLink href={auth.logoutUrl()} title={session.email}>
            Sign out
          </SignOutLink>
        </span>
      </header>
      <BrowserRulesImport />
      <PushRenewal />
      {children}
    </>
  );
}
