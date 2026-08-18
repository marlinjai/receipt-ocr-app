/**
 * Pure workspace-access helpers (no server-only imports, unit-testable).
 * The prisma-backed resolution lives in `auth-guards.ts`.
 */

export interface SessionLike {
  memberships: Array<{ id: string; slug: string; role: string; tenantId?: string }>;
  activeWorkspace: { id: string; slug: string; role: string; tenantId?: string } | null;
  /**
   * The session's GLOBAL active company (auth-brain `active_tenant`).
   *
   * Deliberately NOT what data is attributed to. See `sessionTenantId`.
   */
  defaultTenantId?: string | null;
}

/** Thrown when a real session would otherwise persist a row with no company. */
export class MissingTenantError extends Error {
  constructor() {
    super(
      'this session has no active company, so the row it would write could not be attributed to one',
    );
    this.name = 'MissingTenantError';
  }
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

/**
 * The company (auth-brain tenant) that owns the session's ACTIVE WORKSPACE.
 *
 * This is the value rows are attributed to, and it is deliberately NOT
 * `session.defaultTenantId`. The two differ, by design: `defaultTenantId` is the
 * session's global active company, while the active workspace may belong to a
 * different one. The auth-brain switcher calls that the "differs from default"
 * state and renders a hint for it, so it is a supported everyday condition, not
 * an edge case.
 *
 * Attributing a row to `defaultTenantId` while the user is working inside
 * another company's workspace would file that company's data under the wrong
 * owner, which is precisely the mis-attribution this column exists to prevent.
 * The workspace is the thing the data actually hangs off, so its owner wins.
 *
 * Returns null only when there is no active workspace at all, which in practice
 * means the development bypass.
 */
export function sessionTenantId(session: SessionLike): string | null {
  return session.activeWorkspace?.tenantId ?? null;
}

/**
 * The company owning a NAMED workspace of this session.
 *
 * Used by write paths that address a workspace explicitly (a table's owning
 * workspace, say) rather than implicitly through the active one, so the row is
 * attributed to the company that owns the data being written and not to
 * whichever workspace happened to be active in the tab.
 *
 * No network call: the verified session already carries `tenantId` on every
 * membership, both sides of the join having been resolved by auth-brain when
 * the session was issued.
 */
export function tenantIdForWorkspace(
  session: SessionLike,
  workspaceId: string,
): string | null {
  return session.memberships.find((m) => m.id === workspaceId)?.tenantId ?? null;
}

/**
 * The company id to stamp on a write, or a thrown `MissingTenantError`.
 *
 * The rule this enforces is the one the column cannot: a REAL session must
 * never write a NULL company, because a row that is attributable to nobody is
 * exactly the state tenant scoping exists to make impossible. It fails loudly
 * at the write instead.
 *
 * The development bypass is the single exception and returns null. It is
 * identified the same way the rest of this module identifies it, by having no
 * memberships at all, an invariant the package guarantees: in production
 * `getSession()` returns null rather than a zero-membership session, so this
 * branch is unreachable outside development.
 *
 * Pass `workspaceId` when the write targets a specific workspace; omit it to
 * use the active one.
 */
export function requireSessionTenantId(
  session: SessionLike,
  workspaceId?: string,
): string | null {
  const tenantId = workspaceId
    ? tenantIdForWorkspace(session, workspaceId)
    : sessionTenantId(session);
  if (tenantId) return tenantId;
  if (session.memberships.length === 0) return null;
  throw new MissingTenantError();
}
