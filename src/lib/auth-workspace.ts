/**
 * Pure workspace-access helpers (no server-only imports, unit-testable).
 * The prisma-backed resolution lives in `auth-guards.ts`.
 */

export interface SessionLike {
  memberships: Array<{ id: string; slug: string; role: string }>;
  activeWorkspace: { id: string; slug: string; role: string } | null;
}

/**
 * The data-layer workspace id for the dev-bypass session (local dev with
 * `AUTH_DEV_USER_EMAIL`, no real memberships): the legacy local workspace,
 * overridable via `AUTH_DEV_WORKSPACE_ID`.
 */
export function devFallbackWorkspaceId(): string {
  return process.env.AUTH_DEV_WORKSPACE_ID?.trim() || 'receipt-ocr';
}

/**
 * May `session` touch data in `workspaceId`? Membership of the owning
 * workspace is required; the dev bypass (no memberships, development only)
 * may touch only the local dev workspace. Fail-closed.
 *
 * Cross-package invariant this relies on (verified against
 * @marlinjai/auth-brain-nextjs 0.2.0): a zero-membership session can ONLY be
 * the NODE_ENV=development bypass. In production, getSession() returns null
 * for a verified user whose tenants hold no `receipts` grant (never an empty-
 * membership session), so the dev branch below is unreachable in prod.
 */
export function sessionMayAccessWorkspace(
  session: SessionLike,
  workspaceId: string,
  devWorkspaceId: string = devFallbackWorkspaceId(),
): boolean {
  if (session.memberships.length === 0) return workspaceId === devWorkspaceId;
  return session.memberships.some((m) => m.id === workspaceId);
}

/**
 * The data-layer workspace id for a session: the VALIDATED active workspace's
 * auth-brain UUID, or the local dev workspace for the bypass. Never derived
 * from anything the browser sends.
 */
export function sessionWorkspaceId(session: SessionLike): string {
  return session.activeWorkspace?.id ?? devFallbackWorkspaceId();
}

/**
 * Human label for a company workspace slug. In app-grant mode a slug is the
 * plain company slug (`lola-stories`), so we title-case it as-is; the legacy
 * `receipts-` prefix is stripped ONLY when still present, purely for
 * back-compat display of workspaces provisioned before the door flip.
 */
export function workspaceLabel(slug: string): string {
  const company = slug.replace(/^receipts-/, '');
  return company
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
