import { auth } from '@/lib/auth';
import { initializeReceiptsTable } from './actions';
import WorkspaceSwitcher from '@/components/WorkspaceSwitcher';
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
      <header
        className="relative z-20 flex items-center justify-between gap-4 px-6 py-3 border-b"
        style={{ borderColor: 'var(--border, rgba(128,128,128,0.2))' }}
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
            Receipts
          </span>
          {active && (
            <span
              className="px-2.5 py-1 rounded-full text-xs font-semibold uppercase tracking-wide"
              style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
            >
              {workspaceLabel(active.slug)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <WorkspaceSwitcher
            memberships={session.memberships.map((m) => ({ id: m.id, slug: m.slug }))}
            activeWorkspaceId={active?.id ?? null}
          />
          <a
            href={auth.logoutUrl()}
            className="text-xs transition-colors hover:underline"
            style={{ color: 'var(--muted)' }}
            title={session.email}
          >
            Sign out
          </a>
        </div>
      </header>
      {children}
    </>
  );
}
