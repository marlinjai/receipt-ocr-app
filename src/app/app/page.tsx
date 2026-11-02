import { auth } from '@/lib/auth';
import { sessionWorkspaceId, uploadTargets } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { paymentAwaitingReceipt } from '@/lib/spending/loop-service';
import UploadPageClient, { type UploadFor } from './UploadPageClient';

export const dynamic = 'force-dynamic';

type UploadParams = Promise<{ fuer?: string | string[]; firma?: string | string[] }>;

/**
 * The upload page. The company uploads go into is decided HERE, once, when the
 * page opens (the active company at that moment), and then travels with every
 * upload the page sends. The page never asks the session again, so switching
 * the company in another tab cannot move an upload that is under way.
 *
 * Opened from a check card (`?fuer=<payment>&firma=<company>`), the page
 * uploads FOR that payment: into the company the payment waits in (named by
 * the card, not the session, so a switch in another tab does not lose it), and
 * the saved receipt is linked to it.
 */
export default async function UploadPage({ searchParams }: { searchParams: UploadParams }) {
  const session = await auth.requireSession('/app');
  const targets = uploadTargets(session);
  const active = sessionWorkspaceId(session);
  const initialWorkspaceId = targets.some((t) => t.workspaceId === active) ? active : (targets[0]?.workspaceId ?? '');
  const { fuer, firma } = await searchParams;
  const asked = typeof fuer === 'string' && fuer !== '' ? fuer : null;
  // The payment's company: the one the card named, else the active one. Only a company this account uploads into is
  // looked in; any other leaves nothing to link, and the page says so.
  const company = typeof firma === 'string' && firma !== '' ? firma : active;
  const uploadable = targets.some((t) => t.workspaceId === company);
  const uploadFor = asked === null ? null : uploadable ? await forPayment(company, asked) : ({ state: 'gone', workspaceId: company } as const);
  return <UploadPageClient targets={targets} initialWorkspaceId={initialWorkspaceId} uploadFor={uploadFor} />;
}

async function forPayment(workspaceId: string, paymentId: string): Promise<UploadFor> {
  const payment = await paymentAwaitingReceipt(prisma, workspaceId, paymentId);
  return payment ? { state: 'open', workspaceId, payment } : { state: 'gone', workspaceId };
}
