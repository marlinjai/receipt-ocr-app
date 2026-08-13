'use client';

import { WorkspaceSwitcher as SharedSwitcher } from '@marlinjai/auth-brain-nextjs/switcher';
import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import { resetWorkspace, switchWorkspace } from '@/app/app/workspace-actions';

/**
 * Company switcher, a thin styled wrapper over the suite's shared headless
 * switcher (auth-brain-nextjs 0.4.1). A finance tool must never be ambiguous
 * about whose books are on screen: the shared component labels options by
 * COMPANY name (Company / Workspace only from a second workspace on), always
 * shows the active selection, no-ops on re-select, and switching refreshes
 * every server component so the whole page re-reads the new workspace. When
 * the local choice differs from the session's global default company, it
 * shows a hint with a reset affordance.
 */
export default function WorkspaceSwitcher({ session }: { session: AppSession }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm" style={{ color: 'var(--muted)' }}>
      <span className="uppercase text-xs tracking-wide">Company</span>
      <SharedSwitcher
        session={session}
        switchAction={switchWorkspace}
        resetAction={resetWorkspace}
        className="inline-flex items-center gap-2"
        selectClassName="glass-panel rounded-lg px-3 py-1.5 text-sm font-medium outline-none text-[color:var(--foreground)] bg-[color:var(--background)]"
        hintClassName="inline-flex items-center gap-1.5 text-xs text-[color:var(--muted)]"
        resetClassName="underline hover:no-underline"
        errorClassName="text-xs text-red-600"
        labels={{
          select: 'Active company workspace',
          differs: 'Differs from your default company',
          reset: 'Reset',
        }}
      />
    </label>
  );
}
