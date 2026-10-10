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
  // Public: the liveness probe, and the static files a browser fetches WITHOUT
  // the session cookie when it installs the app or its service worker (the
  // manifest and its icons, the worker script, the offline page). They carry no
  // data. Behind the login they answered with a redirect, which made the app
  // impossible to install to the home screen.
  // /api/internal/erasure is auth-brain's signed erasure webhook: a machine caller
  // that authenticates by HMAC over the raw body (see src/lib/erasure.ts). The
  // retention purge and the workspace move (src/lib/workspace-move.ts) are machine
  // callers of the same kind, each with its own secret, each refusing without it.
  publicPaths: [
    '/api/health',
    '/api/internal/erasure',
    '/api/internal/retention/purge',
    '/api/internal/workspace-move',
    '/manifest.json',
    '/icons/*',
    '/sw.js',
    '/offline.html',
  ],
  publicUrl: 'https://receipts.lumitra.co',
});

export type ReceiptsAction =
  | 'receipts.upload'
  | 'receipts.row.write'
  | 'receipts.schema.write'
  | 'receipts.fx.recompute'
  | 'receipts.import';
