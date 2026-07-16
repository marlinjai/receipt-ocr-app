'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { switchWorkspace } from '@/app/app/workspace-actions';
import { workspaceLabel } from '@/lib/auth-workspace';

export interface WorkspaceOption {
  id: string;
  slug: string;
}

/**
 * Company switcher. A finance tool must never be ambiguous about whose books
 * are on screen: the active company is always visible here, and switching
 * refreshes every server component so the whole page re-reads the new
 * workspace.
 */
export default function WorkspaceSwitcher({
  memberships,
  activeWorkspaceId,
}: {
  memberships: WorkspaceOption[];
  activeWorkspaceId: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  if (memberships.length === 0) {
    // Dev bypass: no real memberships, nothing to switch.
    return null;
  }

  return (
    <label className="inline-flex items-center gap-2 text-sm" style={{ color: 'var(--muted)' }}>
      <span className="uppercase text-xs tracking-wide">Company</span>
      <select
        value={activeWorkspaceId ?? memberships[0].id}
        disabled={isPending}
        onChange={(e) => {
          const id = e.target.value;
          startTransition(async () => {
            const { ok } = await switchWorkspace(id);
            if (ok) router.refresh();
          });
        }}
        className="glass-panel rounded-lg px-3 py-1.5 text-sm font-medium outline-none"
        style={{ color: 'var(--foreground)', background: 'var(--background)' }}
        aria-label="Active company workspace"
      >
        {memberships.map((m) => (
          <option key={m.id} value={m.id}>
            {workspaceLabel(m.slug)}
          </option>
        ))}
      </select>
    </label>
  );
}
