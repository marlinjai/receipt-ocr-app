/**
 * Move the receipts app's guest list into the suite's shared contacts database
 * (wave 2 of the shared contact model, see docs/plans/2026-10-09-shared-contacts-wave2.md).
 *
 * Three modes, in the order they are meant to run:
 *   --layout   Apply the shared database layout only. Additive; nothing is moved.
 *   (default)  Dry run. Reads both databases, writes nothing, prints what --apply would do.
 *   --apply    Moves the data, company by company. Run only after the dry run's report was read.
 *
 *   DATABASE_URL=<receipts> CONTACTS_DATABASE_URL=<contacts> \
 *     npx tsx scripts/move-contacts.ts [--tenant <companyId>] [--map <workspaceId>=<companyId>]...
 *
 * --map gives the company of old rows that name none, one per workspace. The move
 * refuses to run while any row has no company, so every guest is accounted for.
 *
 * Output carries ids and counts only, never a name. Errors print the error code,
 * never the message, because a connection error can echo a host.
 */
import { PrismaClient } from '@prisma/client';
import { contactsFor, createContactsDb, migrate, missingMigrations } from '@marlinjai/contacts-core';
import { moveCompany, planMove, type CompanyCounts, type OldContact } from './lib/contacts-move';

interface Args {
  mode: 'layout' | 'dry-run' | 'apply';
  tenant: string | null;
  maps: Array<[string, string]>;
}

function fail(message: string, exitCode = 2): never {
  console.error(message);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', tenant: null, maps: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') args.mode = 'apply';
    else if (arg === '--layout') args.mode = 'layout';
    else if (arg === '--tenant') args.tenant = argv[++i] ?? fail('--tenant needs a company id');
    else if (arg === '--map') {
      const value = argv[++i] ?? '';
      const [workspace, tenant] = value.split('=');
      if (!workspace || !tenant) fail('--map needs <workspaceId>=<companyId>');
      args.maps.push([workspace, tenant]);
    } else fail(`unknown argument: ${arg}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const receiptsUrl = process.env.DATABASE_URL;
  const contactsUrl = process.env.CONTACTS_DATABASE_URL;
  if (!receiptsUrl || !contactsUrl) fail('DATABASE_URL and CONTACTS_DATABASE_URL must both be set (see the plan for the piped run).');

  const db = new PrismaClient({ datasourceUrl: receiptsUrl });
  const handle = createContactsDb(contactsUrl, { applicationName: 'receipts-move', max: 2 });
  try {
    const missing = await missingMigrations(handle.sql);
    if (args.mode === 'layout') {
      const result = await migrate(handle.sql);
      console.log(JSON.stringify({ mode: 'layout', applied: result.applied, alreadyApplied: result.alreadyApplied }, null, 2));
      return;
    }
    if (missing.length > 0) {
      fail(`The shared database has ${missing.length} layout step(s) missing. Run with --layout first; it only adds tables.`);
    }

    const rows: OldContact[] = await db.contact.findMany({
      select: {
        id: true,
        authWorkspaceId: true,
        authTenantId: true,
        name: true,
        companyOrRole: true,
        note: true,
        archivedAt: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const plan = planMove(rows, new Map(args.maps));
    if (plan.skippedNoTenant > 0) {
      fail(
        `${plan.skippedNoTenant} row(s) name no company and their workspace has no --map. Nothing was written. ` +
          'Add a --map <workspaceId>=<companyId> for each workspace concerned (the dry run lists none of the names).',
      );
    }

    const tenants = args.tenant ? [args.tenant] : [...plan.groups.keys()];
    const companies: CompanyCounts[] = [];
    const errors: Array<{ tenant: string; code: string }> = [];
    for (const tenant of tenants) {
      try {
        companies.push(
          await moveCompany(plan.groups.get(tenant) ?? [], {
            shared: contactsFor(handle, tenant),
            db,
            apply: args.mode === 'apply',
          }),
        );
      } catch (e) {
        errors.push({ tenant, code: (e as { code?: string }).code ?? (e as Error).name });
      }
    }

    const sum = (pick: (c: CompanyCounts) => number) => companies.reduce((n, c) => n + pick(c), 0);
    console.log(
      JSON.stringify(
        {
          mode: args.mode,
          oldRows: rows.length,
          companies,
          errors,
          totals: {
            created: sum((c) => c.created),
            merged: sum((c) => c.merged),
            guestRowsRepointed: sum((c) => c.guestRowsRepointed),
            guestRowsDeduplicated: sum((c) => c.guestRowsDeduplicated),
            guestRowsPending: sum((c) => c.guestRowsPending),
          },
        },
        null,
        2,
      ),
    );
    if (errors.length > 0) process.exitCode = 1;
  } finally {
    await db.$disconnect();
    await handle.close();
  }
}

main().catch((e: unknown) => {
  console.error(`move failed: ${(e as Error)?.name ?? 'error'}`);
  process.exitCode = 1;
});
