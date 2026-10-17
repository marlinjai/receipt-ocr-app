import Link from 'next/link';
import { auth } from '@/lib/auth';
import { initializeReceiptsTable } from './actions';
import WorkspaceSwitcher from '@/components/WorkspaceSwitcher';
import BrowserRulesImport from '@/components/BrowserRulesImport';
import { PushRenewal, SignOutLink } from './spending/PushSession';
import { workspaceLabel } from '@/lib/auth-workspace';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
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
        on, everything stands in one row as before.
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
        <Link href="/app/spending" className="ml-auto whitespace-nowrap text-xs transition-colors hover:underline" style={{ color: 'var(--muted)' }}>
          Ausgaben
        </Link>
        <div className="order-last w-full min-w-0 sm:order-none sm:w-auto">
          <WorkspaceSwitcher session={session} />
        </div>
        <span className="whitespace-nowrap">
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
