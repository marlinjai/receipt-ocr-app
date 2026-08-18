import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  sessionMayAccessWorkspace,
  sessionWorkspaceId,
  devFallbackWorkspaceId,
  workspaceLabel,
  sessionTenantId,
  tenantIdForWorkspace,
  requireSessionTenantId,
  MissingTenantError,
  type SessionLike,
} from '../auth-workspace';

afterEach(() => vi.unstubAllEnvs());

// App-grant mode: workspace slugs are plain company slugs (no `receipts-`
// prefix); access is decided by the tenant's `receipts` grant, not the name.
const WS_LOLA = { id: 'ws_lola', slug: 'lola-stories', role: 'member' };
const WS_MJ = { id: 'ws_mj', slug: 'marlinjai', role: 'member' };

function session(overrides: Partial<SessionLike> = {}): SessionLike {
  return { memberships: [WS_LOLA, WS_MJ], activeWorkspace: WS_LOLA, ...overrides };
}

describe('sessionMayAccessWorkspace', () => {
  it('allows a member workspace', () => {
    expect(sessionMayAccessWorkspace(session(), 'ws_mj')).toBe(true);
  });

  it('DENIES a non-member workspace (cross-company isolation, fail-closed)', () => {
    expect(sessionMayAccessWorkspace(session(), 'ws_other_company')).toBe(false);
  });

  it('scopes the dev bypass (no memberships) to ONLY the local dev workspace', () => {
    const dev = session({ memberships: [], activeWorkspace: null });
    expect(sessionMayAccessWorkspace(dev, 'receipt-ocr')).toBe(true);
    expect(sessionMayAccessWorkspace(dev, 'ws_lola')).toBe(false);
  });
});

describe('sessionWorkspaceId', () => {
  it('returns the VALIDATED active workspace id', () => {
    expect(sessionWorkspaceId(session())).toBe('ws_lola');
    expect(sessionWorkspaceId(session({ activeWorkspace: WS_MJ }))).toBe('ws_mj');
  });

  it('falls back to the local dev workspace for the bypass session', () => {
    expect(sessionWorkspaceId(session({ memberships: [], activeWorkspace: null }))).toBe(
      'receipt-ocr',
    );
  });

  it('honors AUTH_DEV_WORKSPACE_ID for the bypass fallback', () => {
    vi.stubEnv('AUTH_DEV_WORKSPACE_ID', 'my-dev-ws');
    expect(devFallbackWorkspaceId()).toBe('my-dev-ws');
    expect(sessionWorkspaceId(session({ memberships: [], activeWorkspace: null }))).toBe(
      'my-dev-ws',
    );
  });
});

describe('workspaceLabel', () => {
  it('title-cases a plain company slug (app-grant mode, no prefix)', () => {
    expect(workspaceLabel('lola-stories')).toBe('Lola Stories');
    expect(workspaceLabel('marlinjai')).toBe('Marlinjai');
    expect(workspaceLabel('lumitra')).toBe('Lumitra');
  });

  it('still strips a legacy `receipts-` prefix if present (back-compat)', () => {
    expect(workspaceLabel('receipts-lola-stories')).toBe('Lola Stories');
    expect(workspaceLabel('receipts-marlinjai')).toBe('Marlinjai');
  });
});

// ---------------------------------------------------------------------------
// Tenant scoping (phase 0 of the books/receipts integration)
// ---------------------------------------------------------------------------

// Two workspaces owned by DIFFERENT companies, which is the whole point: the
// company a row belongs to has to follow the workspace, not the session.
const WS_LOLA_T = { id: 'ws_lola', slug: 'lola-stories', role: 'member', tenantId: 'tnt_lola' };
const WS_MJ_T = { id: 'ws_mj', slug: 'marlinjai', role: 'member', tenantId: 'tnt_marlinjai' };

function tenantSession(overrides: Partial<SessionLike> = {}): SessionLike {
  return {
    memberships: [WS_LOLA_T, WS_MJ_T],
    activeWorkspace: WS_LOLA_T,
    defaultTenantId: 'tnt_marlinjai',
    ...overrides,
  };
}

describe('sessionTenantId', () => {
  it('returns the company owning the ACTIVE WORKSPACE, not the session default', () => {
    // The session's global active company is marlinjai while the active
    // workspace belongs to lola-stories. This is the supported
    // "differs from default" state, and attributing rows to the default here
    // would file lola-stories data under marlinjai.
    const s = tenantSession();
    expect(s.defaultTenantId).toBe('tnt_marlinjai');
    expect(sessionTenantId(s)).toBe('tnt_lola');
  });

  it('returns null for the dev bypass (no active workspace)', () => {
    expect(sessionTenantId({ memberships: [], activeWorkspace: null })).toBeNull();
  });
});

describe('tenantIdForWorkspace', () => {
  it('resolves each workspace to its OWN company, not the active one', () => {
    const s = tenantSession();
    expect(tenantIdForWorkspace(s, 'ws_lola')).toBe('tnt_lola');
    expect(tenantIdForWorkspace(s, 'ws_mj')).toBe('tnt_marlinjai');
  });

  it('returns null for a workspace this session is not a member of', () => {
    expect(tenantIdForWorkspace(tenantSession(), 'ws_someone_else')).toBeNull();
  });
});

describe('requireSessionTenantId', () => {
  it('returns the active workspace company by default', () => {
    expect(requireSessionTenantId(tenantSession())).toBe('tnt_lola');
  });

  it('honours an explicit workspace so a write lands on the right company', () => {
    expect(requireSessionTenantId(tenantSession(), 'ws_mj')).toBe('tnt_marlinjai');
  });

  it('REJECTS a real session with no resolvable company instead of writing NULL', () => {
    // A row nobody owns is exactly the state tenant scoping exists to prevent,
    // so this must throw at the write rather than persist a null company.
    const noTenant: SessionLike = {
      memberships: [{ id: 'ws_lola', slug: 'lola-stories', role: 'member' }],
      activeWorkspace: { id: 'ws_lola', slug: 'lola-stories', role: 'member' },
    };
    expect(() => requireSessionTenantId(noTenant)).toThrow(MissingTenantError);
  });

  it('REJECTS a real session writing to a workspace it does not belong to', () => {
    expect(() => requireSessionTenantId(tenantSession(), 'ws_someone_else')).toThrow(
      MissingTenantError,
    );
  });

  it('allows the dev bypass (no memberships) to write a null company', () => {
    expect(requireSessionTenantId({ memberships: [], activeWorkspace: null })).toBeNull();
  });
});
