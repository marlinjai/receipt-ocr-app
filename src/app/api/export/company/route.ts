import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';
import { companyContacts } from '@/lib/contacts/db';
import { buildExportArchive, collectCompanyExport, sha256Hex } from '@/lib/company-export';
import { prisma } from '@/lib/prisma';

/**
 * The company's data export: the business meal register and the contacts, as one
 * zip. The company keeps it; it is the copy that lets the company's printed guest
 * names be removed from this app (see erasure.ts). Each download is recorded with
 * its file count and hash.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  let session;
  try {
    session = await auth.requireAction('receipts.row.write');
  } catch (e) {
    const status = (e as { status?: number })?.status === 401 ? 401 : 403;
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status });
  }

  let tenantId: string;
  try {
    const resolved = requireSessionTenantId(session, sessionWorkspaceId(session));
    if (!resolved) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    tenantId = resolved;
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const workspaceIds = [
    ...new Set(session.memberships.filter((m) => m.tenantId === tenantId).map((m) => m.id)),
  ];
  const shared = process.env.CONTACTS_DATABASE_URL?.trim() ? companyContacts(tenantId) : null;
  const files = await collectCompanyExport({ db: prisma, tenantId, workspaceIds, shared });
  const zip = buildExportArchive(files);
  await prisma.companyExport.create({
    data: { authTenantId: tenantId, fileCount: files.length, sha256: sha256Hex(zip) },
  });

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(new Uint8Array(zip), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="lumitra-export-${date}.zip"`,
      'cache-control': 'no-store',
    },
  });
}
