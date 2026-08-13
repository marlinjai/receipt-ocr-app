'use server';

import { auth } from '@/lib/auth';

/**
 * Workspace-switcher server action. The requested id is validated against the
 * VERIFIED membership set inside the package before the `receipts_ws` cookie
 * is written (the cookie is a selector, never a credential).
 */
export async function switchWorkspace(workspaceId: string): Promise<{ ok: boolean }> {
  return auth.setActiveWorkspace(workspaceId);
}

/**
 * Reset-to-default server action: clears the app-local `receipts_ws` override
 * so the app follows the session's global default company again.
 */
export async function resetWorkspace(): Promise<{ ok: boolean }> {
  return auth.clearActiveWorkspace();
}
