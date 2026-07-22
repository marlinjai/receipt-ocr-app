import 'server-only';
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { prisma } from '@/lib/prisma';

/**
 * Workspace-editable per-vendor attribution %, the configurable replacement for
 * the hardcoded VENDOR_BUSINESS_SHARE_DEFAULTS. A vendor "keyword" matches an
 * invoice vendor by case-insensitive substring (same semantics as the
 * constant), so "Anthropic" covers "Anthropic (Claude)". The reserved `*` row
 * holds the workspace default for unlisted vendors (else 100%).
 */

const TABLE_NAME = 'Receipts';
const DEFAULT_KEY = '*';

export interface VendorShare {
  vendor: string;
  share: number; // 0-100
}

const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

export async function getAttribution(
  workspaceId: string,
): Promise<{ rules: VendorShare[]; defaultShare: number }> {
  const rows = await prisma.workspaceVendorAttribution.findMany({
    where: { authWorkspaceId: workspaceId },
    orderBy: { vendor: 'asc' },
  });
  const def = rows.find((r) => r.vendor === DEFAULT_KEY);
  return {
    rules: rows.filter((r) => r.vendor !== DEFAULT_KEY).map((r) => ({ vendor: r.vendor, share: r.share })),
    defaultShare: def?.share ?? 100,
  };
}

/** Resolve a vendor's share from the workspace rules (substring), else default. */
export function resolveShare(vendor: string | null, rules: VendorShare[], defaultShare: number): number {
  if (!vendor) return defaultShare;
  const v = vendor.toLowerCase();
  for (const r of rules) {
    if (r.vendor.trim() && v.includes(r.vendor.toLowerCase())) return r.share;
  }
  return defaultShare;
}

export async function setAttribution(
  workspaceId: string,
  rules: VendorShare[],
  defaultShare: number,
): Promise<void> {
  const clean = rules
    .filter((r) => r.vendor.trim())
    .map((r) => ({ authWorkspaceId: workspaceId, vendor: r.vendor.trim(), share: clampPct(r.share) }));
  await prisma.$transaction([
    prisma.workspaceVendorAttribution.deleteMany({ where: { authWorkspaceId: workspaceId } }),
    prisma.workspaceVendorAttribution.createMany({
      data: [{ authWorkspaceId: workspaceId, vendor: DEFAULT_KEY, share: clampPct(defaultShare) }, ...clean],
    }),
  ]);
}

/**
 * Write the resolved per-vendor share onto every Receipts row's Business Share %,
 * so the ledger + its Attributed EUR formula match the attribution settings.
 * Only touches rows whose share actually changes. Returns how many were updated.
 */
export async function applyAttributionToLedger(workspaceId: string): Promise<number> {
  const { rules, defaultShare } = await getAttribution(workspaceId);
  const adapter = new PrismaAdapter({ prisma });
  const tables = await adapter.listTables(workspaceId);
  const table = tables.find((t) => t.name === TABLE_NAME);
  if (!table) return 0;

  const columns = await adapter.getColumns(table.id);
  const vendorCol = columns.find((c) => c.name === 'Vendor');
  const shareCol = columns.find((c) => c.name === 'Business Share %');
  if (!vendorCol || !shareCol) return 0;

  // Page through FIRST, then mutate: updating rows while offset-paginating can
  // skip/repeat rows if the adapter's ordering shifts under the updates.
  const rows: { id: string; vendor: string | null; current: unknown }[] = [];
  let offset = 0;
  for (;;) {
    const page = await adapter.getRows(table.id, { limit: 500, offset });
    for (const row of page.items) {
      rows.push({
        id: row.id,
        vendor: typeof row.cells[vendorCol.id] === 'string' ? (row.cells[vendorCol.id] as string) : null,
        current: row.cells[shareCol.id],
      });
    }
    if (!page.hasMore || page.items.length === 0) break;
    offset += page.items.length;
  }

  let updated = 0;
  for (const row of rows) {
    const want = resolveShare(row.vendor, rules, defaultShare);
    if (Number(row.current) !== want) {
      await adapter.updateRow(row.id, { [shareCol.id]: want });
      updated++;
    }
  }
  return updated;
}
