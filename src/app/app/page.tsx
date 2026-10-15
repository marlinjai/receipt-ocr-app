import { auth } from '@/lib/auth';
import { sessionWorkspaceId, uploadTargets } from '@/lib/auth-workspace';
import UploadPageClient from './UploadPageClient';

export const dynamic = 'force-dynamic';

/**
 * The upload page. The company uploads go into is decided HERE, once, when the
 * page opens (the active company at that moment), and then travels with every
 * upload the page sends. The page never asks the session again, so switching
 * the company in another tab cannot move an upload that is under way.
 */
export default async function UploadPage() {
  const session = await auth.requireSession('/app');
  const targets = uploadTargets(session);
  const active = sessionWorkspaceId(session);
  const initialWorkspaceId = targets.some((t) => t.workspaceId === active) ? active : (targets[0]?.workspaceId ?? '');
  return <UploadPageClient targets={targets} initialWorkspaceId={initialWorkspaceId} />;
}
