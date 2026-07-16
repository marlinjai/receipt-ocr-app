import { createAuthBrainNextjs } from '@marlinjai/auth-brain-nextjs';

/**
 * The single auth-brain integration config for the receipts app.
 *
 * Multi-workspace mode: every auth-brain workspace whose slug starts with
 * `receipts-` is a company book this user may open (receipts-lola-stories,
 * receipts-marlinjai, receipts-lumitra). The active one is selected via the
 * validated `receipts_ws` cookie; `dt_tables.workspace_id` is partitioned by
 * the ACTIVE workspace's auth-brain UUID.
 *
 * The action vocabulary all maps to `workspace.member` today; the map exists
 * so call sites never change when granularity tightens later (e.g.
 * `receipts.schema.write` -> `workspace.admin`).
 */
export const auth = createAuthBrainNextjs({
  appName: 'receipts',
  workspaces: { slugPrefix: 'receipts-' },
  activeWorkspaceCookie: 'receipts_ws',
  permissions: {
    'receipts.upload': 'workspace.member',
    'receipts.row.write': 'workspace.member',
    'receipts.schema.write': 'workspace.member',
    'receipts.fx.recompute': 'workspace.member',
  },
  publicPaths: ['/api/health'],
  publicUrl: 'https://receipts.lumitra.co',
});

export type ReceiptsAction =
  | 'receipts.upload'
  | 'receipts.row.write'
  | 'receipts.schema.write'
  | 'receipts.fx.recompute';
