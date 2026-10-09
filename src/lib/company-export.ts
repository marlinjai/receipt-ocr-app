import 'server-only';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import type { Contacts } from '@marlinjai/contacts-core';
import type { PrismaClient } from '@prisma/client';
import { registerCsv } from './meals/register-csv';
import { buildRegister, registerYears } from './meals/register';
import { getTaxSettings, loadMealRecords } from './meals/service';

/**
 * The export a company takes with it before its data is erased: the business
 * meal register per workspace and year (CSV), its contacts (JSON), and a readme
 * that says what the files are. Packed into one zip.
 *
 * Only what the company owns is included, and no names are written to logs.
 */

export interface ExportFile {
  path: string;
  data: Uint8Array;
}

export interface CollectInput {
  db: PrismaClient;
  tenantId: string;
  /** The company's workspaces the exporting member can see. */
  workspaceIds: readonly string[];
  /** The company's contacts in the shared database, when that database is in use. */
  shared: Contacts | null;
  now?: Date;
}

export async function collectCompanyExport(input: CollectInput): Promise<ExportFile[]> {
  const now = input.now ?? new Date();
  const files: ExportFile[] = [];
  let registerFiles = 0;

  for (const workspaceId of input.workspaceIds) {
    const records = await loadMealRecords(input.db, workspaceId, { includeDismissed: true });
    const settings = await getTaxSettings(input.db, workspaceId);
    for (const year of registerYears(records)) {
      const register = buildRegister(records, settings, year);
      files.push({ path: `register/${workspaceId}/${year}.csv`, data: strToU8(registerCsv(register)) });
      registerFiles++;
    }
  }

  const contacts = input.shared ? await input.shared.list({ includeArchived: true }) : [];
  const exported = await Promise.all(
    contacts.map(async (c) => input.shared!.exportContact(c.id)),
  );
  files.push({
    path: 'contacts/contacts.json',
    data: strToU8(JSON.stringify(exported.filter((e) => e !== null), null, 2)),
  });

  const legacy = await input.db.contact.findMany({ where: { authTenantId: input.tenantId } });
  files.push({
    path: 'contacts/app-table.json',
    data: strToU8(
      JSON.stringify(
        legacy.map((c) => ({ id: c.id, name: c.name, companyOrRole: c.companyOrRole, note: c.note, archived: c.archivedAt !== null, createdAt: c.createdAt })),
        null,
        2,
      ),
    ),
  });

  files.push({
    path: 'README.txt',
    data: strToU8(buildReadme(now, { registerFiles, contacts: contacts.length, legacy: legacy.length })),
  });
  return files;
}

/** The readme inside the zip. Counts only, no names. */
export function buildReadme(now: Date, counts: { registerFiles: number; contacts: number; legacy: number }): string {
  return [
    'Export of the company data held by Lumitra Receipts',
    `Created: ${now.toISOString()}`,
    '',
    'register/      The business meal register, one CSV per workspace and year (' + counts.registerFiles + ' files).',
    '               It lists each meal with date, place, amount, occasion, host and the guests as printed.',
    'contacts/      The contact list: ' + counts.contacts + ' contacts from the shared contact database, and ' + counts.legacy + ' from the app table.',
    '',
    'Keep this export. German tax law (the Abgabenordnung, AO) requires business records, including',
    'business meal records, to be kept for ten years. Once this export has been handed over, the',
    'printed guest names are removed from Lumitra Receipts.',
    '',
  ].join('\n');
}

/** Pack the files into one zip. Entries are stored in the order given. */
export function buildExportArchive(files: readonly ExportFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f.path] = f.data;
  return zipSync(entries, { level: 6 });
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
