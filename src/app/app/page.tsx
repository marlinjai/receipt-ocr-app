import { auth } from '@/lib/auth';
import { sessionWorkspaceId, uploadTargets } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { paymentAwaitingReceipt } from '@/lib/spending/loop-service';
import UploadPageClient, { type UploadFor } from './UploadPageClient';

export const dynamic = 'force-dynamic';

type UploadParams = Promise<{ fuer?: string | string[] }>;

/**
 * The upload page. The company uploads go into is decided HERE, once, when the
 * page opens (the active company at that moment), and then travels with every
 * upload the page sends. The page never asks the session again, so switching
 * the company in another tab cannot move an upload that is under way.
 *
 * Opened from a check card (`?fuer=<payment>`), the page uploads FOR that
 * payment: into the company the payment waits in, and the saved receipt is
 * linked to it.
 */
export default async function UploadPage({ searchParams }: { searchParams: UploadParams }) {
  const session = await auth.requireSession('/app');
  const targets = uploadTargets(session);
  const active = sessionWorkspaceId(session);
  const initialWorkspaceId = targets.some((t) => t.workspaceId === active) ? active : (targets[0]?.workspaceId ?? '');
  const { fuer } = await searchParams;
  const asked = typeof fuer === 'string' && fuer !== '' ? fuer : null;
  // A payment waits in the active company; when that is not one to upload into, nothing is linked, and the page says so.
  const uploadFor = asked === null ? null : initialWorkspaceId === active ? await forPayment(initialWorkspaceId, asked) : ({ state: 'gone', workspaceId: initialWorkspaceId } as const);
  return <UploadPageClient targets={targets} initialWorkspaceId={initialWorkspaceId} uploadFor={uploadFor} />;
}

async function forPayment(workspaceId: string, paymentId: string): Promise<UploadFor> {
  const payment = await paymentAwaitingReceipt(prisma, workspaceId, paymentId);
  return payment ? { state: 'open', workspaceId, payment } : { state: 'gone', workspaceId };
}
