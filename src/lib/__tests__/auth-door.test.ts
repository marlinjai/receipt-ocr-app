import { describe, it, expect } from 'vitest';
// Note: vitest.config.ts aliases 'next/server' to a bare stub so the wrapper's
// barrel (which imports it for the unused middleware helpers) loads under the
// node test env; we only exercise the pure `matchWorkspaces` door logic here.
import { matchWorkspaces, type WorkspacesConfig } from '@marlinjai/auth-brain-nextjs';
import type {
  Tenant,
  Workspace,
  TenantRole,
  WorkspaceRole,
} from '@marlinjai/auth-brain-shared';

/**
 * Door-level tests for the app-grant mode (Receipts entry gate). The door logic
 * lives in the wrapper's pure `matchWorkspaces`; we feed it verify payloads
 * shaped exactly like `@marlinjai/auth-brain-shared`'s SessionVerifyResponse
 * (`tenants[].app_grants` x `workspaces[].tenant_id`) and assert the gate:
 * a company holding the `receipts` grant opens its workspaces, an ungranted
 * company opens nothing, and a granted company with zero workspaces is a clean
 * no-access rather than a crash.
 */

const ISO = '2026-07-27T00:00:00.000Z';
const CFG: WorkspacesConfig = { appGrant: { app: 'receipts' } };

type SessionTenant = Tenant & { role: TenantRole; app_grants: string[] };
type SessionWorkspace = Workspace & { role: WorkspaceRole };

function tenant(id: string, appGrants: string[]): SessionTenant {
  return {
    id,
    group_id: `grp_${id}`,
    name: id,
    slug: id,
    legal_name: null,
    vat_id: null,
    billing_address: null,
    stripe_customer_id: null,
    retention_hold: false,
    retention_expires_at: null,
    created_at: ISO,
    updated_at: ISO,
    deleted_at: null,
    role: 'owner',
    app_grants: appGrants,
  };
}

function workspace(
  id: string,
  tenantId: string,
  slug: string,
  role: WorkspaceRole = 'member',
): SessionWorkspace {
  return {
    id,
    tenant_id: tenantId,
    name: slug,
    slug,
    created_at: ISO,
    updated_at: ISO,
    deleted_at: null,
    role,
  };
}

describe('app-grant door (matchWorkspaces)', () => {
  it('opens every workspace owned by a tenant holding the receipts grant', () => {
    const session = {
      tenants: [tenant('t_lola', ['receipts', 'studio'])],
      workspaces: [
        workspace('ws_lola', 't_lola', 'lola-stories'),
        workspace('ws_lola_ops', 't_lola', 'lola-ops', 'admin'),
      ],
    };

    const matched = matchWorkspaces(session, CFG);

    expect(matched.map((m) => m.id).sort()).toEqual(['ws_lola', 'ws_lola_ops']);
    expect(matched.every((m) => 'slug' in m && 'role' in m)).toBe(true);
  });

  it('opens nothing when no tenant holds the receipts grant (no-access)', () => {
    const session = {
      tenants: [tenant('t_other', ['studio', 'invoices'])],
      workspaces: [workspace('ws_other', 't_other', 'other-co')],
    };

    expect(matchWorkspaces(session, CFG)).toEqual([]);
  });

  it('ignores a workspace whose owning tenant lacks the grant (cross-tenant isolation)', () => {
    const session = {
      tenants: [
        tenant('t_lola', ['receipts']),
        tenant('t_other', ['studio']),
      ],
      workspaces: [
        workspace('ws_lola', 't_lola', 'lola-stories'),
        workspace('ws_other', 't_other', 'other-co'),
      ],
    };

    expect(matchWorkspaces(session, CFG).map((m) => m.id)).toEqual(['ws_lola']);
  });

  it('is a clean no-access (not a crash) for a granted tenant that owns zero workspaces', () => {
    const session = {
      tenants: [tenant('t_lola', ['receipts'])],
      workspaces: [] as SessionWorkspace[],
    };

    expect(matchWorkspaces(session, CFG)).toEqual([]);
  });
});
