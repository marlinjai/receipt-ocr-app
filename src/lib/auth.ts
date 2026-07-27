import { createAuthBrainNextjs } from '@marlinjai/auth-brain-nextjs';

/**
 * The single auth-brain integration config for the receipts app.
 *
 * App-grant mode: a user may open Receipts iff one of their tenants (companies)
 * holds the `receipts` app grant. The membership set is every workspace owned
 * by a granted tenant (a company book); auth-brain computes that join from the
 * verified session (`tenants[].app_grants` x `workspaces[].tenant_id`), so no
 * extra network call. The active workspace is selected via the validated
 * `receipts_ws` cookie; `dt_tables.workspace_id` stays partitioned by the
 * ACTIVE workspace's auth-brain UUID (data scoping is unchanged by this flip).
 *
 * This replaces the legacy `receipts-` slug-prefix door: entitlement now lives
 * on the tenant grant, not in a magic workspace-naming convention.
 *
 * The action vocabulary all maps to `workspace.member` today; the map exists
 * so call sites never change when granularity tightens later (e.g.
 * `receipts.schema.write` -> `workspace.admin`).
 */
export const auth = createAuthBrainNextjs({
  appName: 'receipts',
  workspaces: { appGrant: { app: 'receipts' } },
  activeWorkspaceCookie: 'receipts_ws',
  permissions: {
    'receipts.upload': 'workspace.member',
    'receipts.row.write': 'workspace.member',
    'receipts.schema.write': 'workspace.member',
    'receipts.fx.recompute': 'workspace.member',
    'receipts.import': 'workspace.member',
  },
  publicPaths: ['/api/health'],
  publicUrl: 'https://receipts.lumitra.co',
});

export type ReceiptsAction =
  | 'receipts.upload'
  | 'receipts.row.write'
  | 'receipts.schema.write'
  | 'receipts.fx.recompute'
  | 'receipts.import';
