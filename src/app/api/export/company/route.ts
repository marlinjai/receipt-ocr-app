import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { companyWorkspaceIds, requireSessionTenantId, sessionWorkspaceId } from '@/lib/auth-workspace';
import { companyContacts } from '@/lib/contacts/db';
import { buildExportArchive, collectCompanyExport, registerHash, sha256Hex } from '@/lib/company-export';
import { prisma } from '@/lib/prisma';

/**
 * The company's data export: the business meal register and the contacts, as one
 * zip. The company keeps it; it is the copy that lets the company's printed guest
 * names be removed from this app, as long as the register has not changed since
 * (see exportCoversRegister in erasure.ts). Each download is recorded with its file
 * count, the hash of the zip and the hash of its register files.
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

  // The same set the erasure of one contact compares the register over.
  const workspaceIds = companyWorkspaceIds(session, tenantId);
  const files = await collectCompanyExport({ db: prisma, workspaceIds, shared: companyContacts(tenantId) });
  const zip = buildExportArchive(files);
  await prisma.companyExport.create({
    data: { authTenantId: tenantId, fileCount: files.length, sha256: sha256Hex(zip), registerSha256: registerHash(files) },
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
