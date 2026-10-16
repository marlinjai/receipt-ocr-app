import { auth } from '@/lib/auth';
import { sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { serverMailbox } from '@/lib/spending/mailbox/gmail';
import { MailboxError } from '@/lib/spending/mailbox/port';
import { findMailCandidate } from '@/lib/spending/mailbox/service';
import { DOWNLOAD_STATUS, contentDisposition } from '@/lib/spending/mailbox/download';
import { servedFileHeaders } from '@/lib/files/served-file-headers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/spending/mail-attachment/:candidateId
 *
 * The bytes of a mail attachment the missing-receipt loop found for a payment
 * of the session's ACTIVE company, fetched from the mailbox right now (nothing
 * is kept on the server). Taking it over is a write, so the fail-closed write
 * check applies, and only the company the mailbox belongs to has candidates
 * at all. The browser hands the bytes to the normal upload path. A candidate
 * of another company answers 404, like one that does not exist.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ candidateId: string }> }) {
  let workspaceId: string;
  try {
    const session = await auth.requireAction('receipts.row.write');
    workspaceId = sessionWorkspaceId(session);
  } catch (e) {
    const status = (e as { status?: number })?.status === 401 ? 401 : 403;
    return Response.json({ error: status === 401 ? 'unauthorized' : 'forbidden' }, { status });
  }
  const { candidateId } = await params;
  try {
    const candidate = await findMailCandidate(prisma, workspaceId, candidateId);
    if (!candidate) return Response.json({ error: 'not_found' }, { status: 404 });
    const file = await serverMailbox(workspaceId).fetchAttachment(candidate.messageId, candidate.partIndex, candidate.fileName);
    return new Response(new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), {
      headers: {
        'Content-Type': file.mimeType,
        'Content-Disposition': contentDisposition(file.fileName),
        'Cache-Control': 'private, no-store',
        // A mailed-in attachment is untrusted: never sniffed, and sandboxed unless it is a PDF or a picture.
        ...servedFileHeaders(file.mimeType),
      },
    });
  } catch (e) {
    if (e instanceof MailboxError) return Response.json({ error: e.code }, { status: DOWNLOAD_STATUS[e.code] });
    console.error('[spending] mail attachment failed', e);
    return Response.json({ error: 'unavailable' }, { status: 502 });
  }
}
