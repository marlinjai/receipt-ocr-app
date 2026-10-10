import 'server-only';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import type { Contacts } from '@marlinjai/contacts-core';
import type { PrismaClient } from '@prisma/client';
import { escapeCSVField } from './export-csv';
import { csvSafeText, registerCsv } from './meals/register-csv';
import { buildRegister, registerYears } from './meals/register';
import { getTaxSettings, loadMealRecords } from './meals/service';
import type { MealRecord } from './meals/types';

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
  /** The company's workspaces the exporting member can see. */
  workspaceIds: readonly string[];
  /** The company's contacts in the shared contacts database. */
  shared: Contacts;
  now?: Date;
}

/** Where the register files live in the zip. Everything under it is what `registerHash` covers. */
export const REGISTER_PREFIX = 'register/';

/**
 * Every printed guest name of a workspace, one line per guest and meal, as
 * semicolon-separated CSV like the register files.
 * The yearly registers list complete business meals only; this list also carries
 * the guests of meals that are incomplete or set aside, so the export holds
 * every printed name the app does.
 */
export function guestCopiesCsv(records: readonly MealRecord[]): string | null {
  const lines: string[] = [];
  for (const record of [...records].sort((a, b) => a.rowId.localeCompare(b.rowId))) {
    record.guests.forEach((guest, position) => {
      lines.push(
        [record.rowId, record.date ?? '', String(position + 1), guest.name, guest.company]
          .map((cell) => escapeCSVField(csvSafeText(cell)))
          .join(';'),
      );
    });
  }
  if (lines.length === 0) return null;
  return ['meal_row_id;date;position;name;company', ...lines].join('\n') + '\n';
}

/**
 * The register part of the export: one CSV per workspace and year, plus the list
 * of all printed guest names per workspace. Deterministic for the same data, so
 * it can be compared later (see `registerHash`).
 */
export async function collectRegisterFiles(db: PrismaClient, workspaceIds: readonly string[]): Promise<ExportFile[]> {
  const files: ExportFile[] = [];
  for (const workspaceId of [...new Set(workspaceIds)].sort()) {
    const records = await loadMealRecords(db, workspaceId, { includeDismissed: true });
    const settings = await getTaxSettings(db, workspaceId);
    for (const year of registerYears(records)) {
      const register = buildRegister(records, settings, year);
      files.push({ path: `${REGISTER_PREFIX}${workspaceId}/${year}.csv`, data: strToU8(registerCsv(register)) });
    }
    const guests = guestCopiesCsv(records);
    if (guests !== null) files.push({ path: `${REGISTER_PREFIX}${workspaceId}/guests.csv`, data: strToU8(guests) });
  }
  return files;
}

/**
 * One SHA-256 over the register files only: path and content of each, sorted by
 * path. The readme and the contact files are left out on purpose (the readme
 * carries a timestamp), so two exports of the same register give the same hash.
 */
export function registerHash(files: readonly ExportFile[]): string {
  const hash = createHash('sha256');
  const register = files.filter((f) => f.path.startsWith(REGISTER_PREFIX)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of register) {
    hash.update(file.path, 'utf8');
    hash.update('\0');
    hash.update(file.data);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** The hash of the register as it is now, for comparing with the hash stored at export time. */
export async function currentRegisterHash(db: PrismaClient, workspaceIds: readonly string[]): Promise<string> {
  return registerHash(await collectRegisterFiles(db, workspaceIds));
}

export async function collectCompanyExport(input: CollectInput): Promise<ExportFile[]> {
  const now = input.now ?? new Date();
  const files: ExportFile[] = await collectRegisterFiles(input.db, input.workspaceIds);
  const registerFiles = files.length;

  const contacts = await input.shared.list({ includeArchived: true });
  const exported = await Promise.all(contacts.map(async (c) => input.shared.exportContact(c.id)));
  files.push({
    path: 'contacts/contacts.json',
    data: strToU8(JSON.stringify(exported.filter((e) => e !== null), null, 2)),
  });

  files.push({
    path: 'README.txt',
    data: strToU8(buildReadme(now, { registerFiles, contacts: contacts.length })),
  });
  return files;
}

/** The readme inside the zip. Counts only, no names. */
export function buildReadme(now: Date, counts: { registerFiles: number; contacts: number }): string {
  return [
    'Export of the company data held by Lumitra Receipts',
    `Created: ${now.toISOString()}`,
    '',
    'register/      The business meal register, one CSV per workspace and year, and one guests.csv per',
    '               workspace with every printed guest name, also of incomplete meals (' + counts.registerFiles + ' files).',
    '               The yearly files list each meal with date, place, amount, occasion, host and guests.',
    'contacts/      The contact list: ' + counts.contacts + ' contacts.',
    '',
    'Keep this export. German tax law (the Abgabenordnung, AO) requires business records, including',
    'business meal records, to be kept for ten years. Printed guest names are removed from Lumitra',
    'Receipts on an erasure only while the register is still identical to this export. After any',
    'later change they are kept there for ten years, until a new export is taken.',
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
