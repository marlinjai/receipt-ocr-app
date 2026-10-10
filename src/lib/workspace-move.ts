import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { ContactError, TRANSFER_MAX, type TransferRefusal } from '@marlinjai/contacts-core';
import { companyContacts } from './contacts/db';
import { repointGuestRows } from './contacts/directory';
import { verifyErasureSignature } from './erasure-signature';

/**
 * The receipts side of moving one workspace to another company.
 *
 * auth-brain decides which company owns a workspace (admin route `PATCH
 * /api/admin/machine/workspaces` with `tenant_id`). This app keeps two things that
 * name the company and therefore have to follow:
 *
 * 1. The company stamp (`auth_tenant_id`) on every row of the workspace. Reads
 *    filter by workspace, so a stale stamp hides nothing, but it would let the row
 *    escape a company erasure. The tables are derived from the Prisma data model
 *    (`stampedModels`), never from a hand-kept list.
 * 2. The contacts the workspace's meals name as guests. They live in the suite's
 *    shared contacts database under the company, and move through the package's
 *    `transferTo`, which keeps their ids. No raw SQL touches the contact tables.
 *
 * Two databases, no shared transaction. The contract instead: the contacts move
 * first (one transaction in the contacts database, all or nothing), then the rows
 * (one transaction in the receipts database). Each half finds what is already done
 * and skips it, so repeating the call finishes a move that stopped half way, and a
 * repeat after completion writes nothing.
 *
 * Rolling back is the same call with the two companies swapped.
 *
 * Reports and log lines carry counts and reason codes only, never a name.
 */

export interface WorkspaceMoveRequest {
  workspaceId: string;
  fromTenantId: string;
  toTenantId: string;
  /**
   * Contacts of the source company that move along although no meal of this
   * workspace names them (a guest kept in the list but not placed on a meal yet).
   * Named by id, so the same list moves them back on a rollback.
   */
  alsoContactIds: readonly string[];
}

/**
 * Why a move is not applied. Any blocker means nothing is written.
 *
 * - `rows_of_another_company`: a row of the workspace is stamped with a company that
 *   is neither the source nor the target. The source company given is probably wrong.
 * - `contacts_not_found`: a guest row (or a requested id) names a contact that exists
 *   in neither company.
 * - `contacts_refused`: the contacts package refuses a contact for a reason this
 *   module does not resolve by itself (`report.contacts.refused` names the reasons).
 * - `contacts_used_by_another_workspace`: a contact that would move is still named by
 *   a meal of another workspace, which would then point across companies.
 * - `too_many_contacts`: more contacts than one transfer takes.
 * - `changed_since_plan`: the contacts changed between the check and the write.
 */
export type MoveBlocker =
  | 'rows_of_another_company'
  | 'contacts_not_found'
  | 'contacts_refused'
  | 'contacts_used_by_another_workspace'
  | 'too_many_contacts'
  | 'changed_since_plan';

export interface TableCounts {
  /** Rows of the workspace in this table. */
  rows: number;
  /** Rows restamped (in a dry run: that would be). Stamped with the source company, or not stamped at all. */
  restamp: number;
  alreadyAtTarget: number;
  /** Rows stamped with a third company. Never rewritten; any such row blocks the move. */
  otherCompany: number;
}

export interface WorkspaceMoveReport {
  dryRun: boolean;
  /** True when this call changed anything. Always false in a dry run and when blocked. */
  written: boolean;
  blocked: MoveBlocker[];
  rows: TableCounts & { tables: Record<string, TableCounts> };
  contacts: {
    /** Distinct contacts named by the meals of this workspace. */
    guests: number;
    /** Ids given in `alsoContactIds`. */
    alsoRequested: number;
    /** Contacts that change company (in a dry run: that would). */
    move: number;
    /** Of those, the ones pulled in only because a person and its organization move together. */
    linkedAlong: number;
    /** Wanted contacts the target company already holds under the same id (a repeat, or a resumed move). */
    alreadyAtTarget: number;
    notFound: number;
    /** Contacts the target already has as the same person or organization. They stay; guest rows are repointed. */
    identityConflicts: number;
    /** Guest rows pointed at the target's existing contact (in a dry run: that would be). */
    guestRowsRepointed: number;
    /** Guest rows removed because the meal already named the target's contact. Known only after an apply. */
    guestRowsFolded: number;
    /** Refusals that block the move, by the package's reason code. */
    refused: Partial<Record<TransferRefusal, number>>;
    /** Guest rows of other workspaces naming a contact that would move. */
    usedByOtherWorkspaces: number;
    sourceBefore: number;
    targetBefore: number;
    /** Measured after an apply, projected in a dry run. */
    sourceAfter: number;
    targetAfter: number;
  };
}

/** The contacts moved, but the rows did not follow. Repeating the call finishes the move. */
export class WorkspaceMoveIncompleteError extends Error {
  readonly contactsMoved: number;
  constructor(contactsMoved: number, cause: unknown) {
    super('workspace move incomplete: the contacts moved, the rows were not restamped', { cause });
    this.name = 'WorkspaceMoveIncompleteError';
    this.contactsMoved = contactsMoved;
  }
}

const COMPANY_FIELD = 'authTenantId';
const WORKSPACE_FIELDS = ['authWorkspaceId', 'workspaceId'] as const;

/**
 * Models that carry a company stamp but belong to the company itself, not to one
 * workspace, so a workspace move leaves them alone. `CompanyExport` records which
 * company took an export; the export stays that company's.
 */
export const COMPANY_KEYED_MODELS: readonly string[] = ['CompanyExport'];

export interface StampedModel {
  model: string;
  table: string;
  /** The Prisma client property for the model. */
  delegate: string;
  workspaceField: (typeof WORKSPACE_FIELDS)[number];
}

interface DataModelEntry {
  name: string;
  dbName?: string | null;
  fields: readonly { name: string }[];
}

/**
 * Every model whose rows belong to a workspace and carry the company stamp, read
 * from the Prisma data model so a table added later is covered without anyone
 * remembering this file. `dt_tables` keys the workspace as `workspaceId`, every
 * other table as `authWorkspaceId`.
 *
 * Fails closed: a model with a company stamp and no workspace column that is not
 * listed in `COMPANY_KEYED_MODELS` throws, so it is looked at instead of skipped.
 */
export function stampedModels(models: readonly DataModelEntry[] = Prisma.dmmf.datamodel.models): StampedModel[] {
  const stamped: StampedModel[] = [];
  for (const model of models) {
    const fields = new Set(model.fields.map((f) => f.name));
    if (!fields.has(COMPANY_FIELD)) continue;
    const workspaceField = WORKSPACE_FIELDS.find((f) => fields.has(f));
    if (!workspaceField) {
      if (COMPANY_KEYED_MODELS.includes(model.name)) continue;
      throw new Error(`workspace move: model ${model.name} carries a company stamp but no workspace column`);
    }
    stamped.push({
      model: model.name,
      table: model.dbName ?? model.name,
      delegate: model.name.charAt(0).toLowerCase() + model.name.slice(1),
      workspaceField,
    });
  }
  if (stamped.length === 0) throw new Error('workspace move: the Prisma data model lists no stamped model');
  return stamped.sort((a, b) => a.table.localeCompare(b.table));
}

/** The two calls made on every stamped model. The client is indexed by name, so the shape is stated here. */
interface StampDelegate {
  groupBy(args: {
    by: ['authTenantId'];
    where: Record<string, unknown>;
    _count: { _all: true };
  }): Promise<Array<{ authTenantId: string | null; _count: { _all: number } }>>;
  updateMany(args: { where: Record<string, unknown>; data: { authTenantId: string } }): Promise<{ count: number }>;
}

type Db = PrismaClient | Prisma.TransactionClient;

function delegateOf(db: Db, model: StampedModel): StampDelegate {
  const delegate = (db as unknown as Record<string, StampDelegate | undefined>)[model.delegate];
  if (!delegate) throw new Error(`workspace move: the Prisma client has no model ${model.model}`);
  return delegate;
}

/** The rows a restamp rewrites: stamped with the source company, or not stamped at all. Never a third company's. */
function restampWhere(model: StampedModel, req: WorkspaceMoveRequest): Record<string, unknown> {
  return {
    [model.workspaceField]: req.workspaceId,
    OR: [{ authTenantId: req.fromTenantId }, { authTenantId: null }],
  };
}

async function countTable(db: Db, model: StampedModel, req: WorkspaceMoveRequest): Promise<TableCounts> {
  const groups = await delegateOf(db, model).groupBy({
    by: ['authTenantId'],
    where: { [model.workspaceField]: req.workspaceId },
    _count: { _all: true },
  });
  const counts: TableCounts = { rows: 0, restamp: 0, alreadyAtTarget: 0, otherCompany: 0 };
  for (const group of groups) {
    const n = group._count._all;
    counts.rows += n;
    if (group.authTenantId === req.toTenantId) counts.alreadyAtTarget += n;
    else if (group.authTenantId === req.fromTenantId || group.authTenantId === null) counts.restamp += n;
    else counts.otherCompany += n;
  }
  return counts;
}

interface Plan {
  report: WorkspaceMoveReport;
  /** Contacts that move, closed under person and organization links. */
  moveIds: string[];
  /** Source contacts the target already has: guest rows go from `fromId` to `toId`, the contact stays. */
  repoints: { fromId: string; toId: string }[];
}

async function planMove(db: PrismaClient, req: WorkspaceMoveRequest): Promise<Plan> {
  const blocked = new Set<MoveBlocker>();

  // 1. The rows.
  const tables: Record<string, TableCounts> = {};
  const totals: TableCounts = { rows: 0, restamp: 0, alreadyAtTarget: 0, otherCompany: 0 };
  for (const model of stampedModels()) {
    const counts = await countTable(db, model, req);
    tables[model.table] = counts;
    totals.rows += counts.rows;
    totals.restamp += counts.restamp;
    totals.alreadyAtTarget += counts.alreadyAtTarget;
    totals.otherCompany += counts.otherCompany;
  }
  if (totals.otherCompany > 0) blocked.add('rows_of_another_company');

  // 2. The contacts the workspace names, and where each of them lives now.
  const guestIds = (
    await db.mealGuest.findMany({
      where: { authWorkspaceId: req.workspaceId, contactId: { not: null } },
      select: { contactId: true },
      distinct: ['contactId'],
    })
  ).map((row) => row.contactId as string);
  const wanted = [...new Set([...guestIds, ...req.alsoContactIds])];

  const source = companyContacts(req.fromTenantId);
  const target = companyContacts(req.toTenantId);
  const sourceAll = await source.list({ includeArchived: true });
  const targetBefore = (await target.list({ includeArchived: true })).length;
  const inSourceById = new Map(sourceAll.map((c) => [c.id, c]));

  const wantedInSource = wanted.filter((id) => inSourceById.has(id));
  const elsewhere = wanted.filter((id) => !inSourceById.has(id));
  const atTarget = new Set((await target.getMany(elsewhere)).map((c) => c.id));
  const notFound = elsewhere.filter((id) => !atTarget.has(id)).length;
  if (notFound > 0) blocked.add('contacts_not_found');

  // 3. A person and its organization move only together, so take the links along until nothing is added.
  const scope = new Set(wantedInSource);
  for (let grew = true; grew; ) {
    grew = false;
    for (const contact of sourceAll) {
      const organizationId = contact.organizationId;
      if (!organizationId || !inSourceById.has(organizationId)) continue;
      if (scope.has(contact.id) && !scope.has(organizationId)) {
        scope.add(organizationId);
        grew = true;
      } else if (!scope.has(contact.id) && scope.has(organizationId)) {
        scope.add(contact.id);
        grew = true;
      }
    }
  }

  // 4. Ask the package what would happen. `skip` reports every contact on its own merits.
  let moveIds: string[] = [];
  const repoints: Plan['repoints'] = [];
  const refused: Partial<Record<TransferRefusal, number>> = {};
  if (scope.size > TRANSFER_MAX) {
    blocked.add('too_many_contacts');
  } else if (scope.size > 0) {
    const preview = await source.transferTo(req.toTenantId, [...scope], { dryRun: true, onConflict: 'skip' });
    for (const item of preview.items) {
      if (item.status === 'moved') {
        moveIds.push(item.id);
      } else if (item.reason === 'identity_conflict' && item.existingId) {
        repoints.push({ fromId: item.id, toId: item.existingId });
      } else {
        const reason = item.reason ?? 'not_found';
        refused[reason] = (refused[reason] ?? 0) + 1;
      }
    }
    if (Object.keys(refused).length > 0) {
      blocked.add('contacts_refused');
      moveIds = [];
    }
  }

  const usedByOtherWorkspaces =
    moveIds.length === 0
      ? 0
      : await db.mealGuest.count({
          where: { contactId: { in: moveIds }, authWorkspaceId: { not: req.workspaceId } },
        });
  if (usedByOtherWorkspaces > 0) blocked.add('contacts_used_by_another_workspace');

  const guestRowsRepointed =
    repoints.length === 0
      ? 0
      : await db.mealGuest.count({
          where: { authWorkspaceId: req.workspaceId, contactId: { in: repoints.map((r) => r.fromId) } },
        });

  const wantedSet = new Set(wanted);
  const willMove = blocked.size === 0 ? moveIds.length : 0;
  return {
    moveIds,
    repoints,
    report: {
      dryRun: true,
      written: false,
      blocked: [...blocked].sort(),
      rows: { ...totals, tables },
      contacts: {
        guests: guestIds.length,
        alsoRequested: new Set(req.alsoContactIds).size,
        move: moveIds.length,
        linkedAlong: moveIds.filter((id) => !wantedSet.has(id)).length,
        alreadyAtTarget: atTarget.size,
        notFound,
        identityConflicts: repoints.length,
        guestRowsRepointed,
        guestRowsFolded: 0,
        refused,
        usedByOtherWorkspaces,
        sourceBefore: sourceAll.length,
        targetBefore,
        sourceAfter: sourceAll.length - willMove,
        targetAfter: targetBefore + willMove,
      },
    },
  };
}

/**
 * Check, and with `apply` carry out, the move of one workspace's rows and guest
 * contacts from one company to another. See the module comment for the contract.
 *
 * A dry run reports what an apply would do and writes nothing. An apply that meets
 * a blocker writes nothing either and says why in `blocked`.
 */
export async function moveWorkspace(
  db: PrismaClient,
  req: WorkspaceMoveRequest,
  options: { apply: boolean },
): Promise<WorkspaceMoveReport> {
  // Nothing here applies the contacts layout: start-up does, and a dry run must not
  // write at all. A contacts database that is unreachable or behind throws on the
  // first query, which the receiver answers with 502.
  const plan = await planMove(db, req);
  if (!options.apply || plan.report.blocked.length > 0) {
    return { ...plan.report, dryRun: !options.apply };
  }
  const report: WorkspaceMoveReport = { ...plan.report, dryRun: false };

  // 1. The contacts, all or nothing. A refusal now means they changed since the plan.
  const changedSincePlan = (): WorkspaceMoveReport => ({
    ...report,
    blocked: ['changed_since_plan'],
    contacts: {
      ...report.contacts,
      move: 0,
      sourceAfter: report.contacts.sourceBefore,
      targetAfter: report.contacts.targetBefore,
    },
  });
  let contactsMoved = 0;
  if (plan.moveIds.length > 0) {
    try {
      const moved = await companyContacts(req.fromTenantId).transferTo(req.toTenantId, plan.moveIds);
      if (!moved.written || moved.moved !== plan.moveIds.length) return changedSincePlan();
      contactsMoved = moved.moved;
    } catch (e) {
      // The package's own refusals (a race on an identity, a number or a link) wrote nothing.
      if (e instanceof ContactError) return changedSincePlan();
      throw e;
    }
  }

  // 2. The rows, in one transaction: guest rows of conflicting contacts first, then every stamp.
  //    Every statement is conditional, so a repeat after completion matches no row and writes nothing.
  const tables: Record<string, TableCounts> = {};
  let restamped = 0;
  let repointed = 0;
  let folded = 0;
  try {
    await db.$transaction(
      async (tx) => {
        for (const { fromId, toId } of plan.repoints) {
          const result = await repointGuestRows(tx, fromId, toId, { authWorkspaceId: req.workspaceId });
          repointed += result.repointed;
          folded += result.deduplicated;
        }
        for (const model of stampedModels()) {
          const { count } = await delegateOf(tx, model).updateMany({
            where: restampWhere(model, req),
            data: { authTenantId: req.toTenantId },
          });
          tables[model.table] = { ...plan.report.rows.tables[model.table], restamp: count };
          restamped += count;
        }
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
  } catch (e) {
    if (contactsMoved > 0) throw new WorkspaceMoveIncompleteError(contactsMoved, e);
    throw e;
  }

  const sourceAfter = (await companyContacts(req.fromTenantId).list({ includeArchived: true })).length;
  const targetAfter = (await companyContacts(req.toTenantId).list({ includeArchived: true })).length;
  return {
    ...report,
    written: contactsMoved > 0 || restamped > 0 || repointed > 0 || folded > 0,
    rows: { ...report.rows, restamp: restamped, tables },
    contacts: {
      ...report.contacts,
      move: contactsMoved,
      guestRowsRepointed: repointed,
      guestRowsFolded: folded,
      sourceAfter,
      targetAfter,
    },
  };
}

/** How far the signed `issued_at` may lie from the server's clock, either way. */
export const MOVE_REQUEST_MAX_AGE_MS = 5 * 60 * 1000;

const ID_MAX = 64;

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= ID_MAX;
}

export interface WorkspaceMoveDelivery {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Decide what one signed call does. Pure apart from `move`, so the rules can be
 * tested without the web framework.
 *
 * The body is JSON: `workspace_id`, `from_tenant_id`, `to_tenant_id`, `mode`
 * (`dry_run` or `apply`, no default), `issued_at` (ISO time of signing) and
 * optionally `also_contact_ids`.
 *
 * - Secret not configured: 503, nothing is read or written.
 * - Signature missing or wrong: 401.
 * - `issued_at` further than `MOVE_REQUEST_MAX_AGE_MS` from now: 401. A move has an
 *   inverse (the same call with the companies swapped), so an old signed call must
 *   not be replayable after a rollback.
 * - Unparseable or incomplete body, or the same company twice: 400.
 * - An apply that is blocked: 409 with the report; nothing was written.
 * - A failure after the contacts moved: 502 with `step: "rows"`; repeating finishes it.
 * - Any other failure: 502.
 *
 * Log lines carry the workspace id, counts and reason codes only.
 */
export async function receiveWorkspaceMove(input: {
  rawBody: string;
  signature: string | null | undefined;
  secret: string | undefined;
  move: (request: WorkspaceMoveRequest, apply: boolean) => Promise<WorkspaceMoveReport>;
  now?: Date;
  log?: (line: string) => void;
}): Promise<WorkspaceMoveDelivery> {
  const log = input.log ?? ((line: string) => console.log(line));
  if (!input.secret) {
    log('[workspace-move] secret not configured, refusing the call');
    return { status: 503, body: { error: 'Service misconfigured' } };
  }
  if (!verifyErasureSignature(input.rawBody, input.signature, input.secret)) {
    return { status: 401, body: { error: 'Invalid signature' } };
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input.rawBody);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    payload = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: { error: 'Malformed payload' } };
  }

  const issuedAt = typeof payload.issued_at === 'string' ? Date.parse(payload.issued_at) : Number.NaN;
  if (Number.isNaN(issuedAt)) return { status: 400, body: { error: 'Missing issued_at' } };
  const now = (input.now ?? new Date()).getTime();
  if (Math.abs(now - issuedAt) > MOVE_REQUEST_MAX_AGE_MS) {
    return { status: 401, body: { error: 'Request expired' } };
  }

  const { workspace_id: workspaceId, from_tenant_id: fromTenantId, to_tenant_id: toTenantId, mode } = payload;
  if (!isId(workspaceId)) return { status: 400, body: { error: 'Missing workspace id' } };
  if (!isId(fromTenantId) || !isId(toTenantId)) return { status: 400, body: { error: 'Missing company id' } };
  if (fromTenantId === toTenantId) return { status: 400, body: { error: 'Source and target company are the same' } };
  if (mode !== 'dry_run' && mode !== 'apply') return { status: 400, body: { error: 'mode must be dry_run or apply' } };
  const also = payload.also_contact_ids ?? [];
  if (!Array.isArray(also) || also.length > TRANSFER_MAX || !also.every(isId)) {
    return { status: 400, body: { error: 'also_contact_ids must be a list of contact ids' } };
  }

  const apply = mode === 'apply';
  const label = apply ? 'apply' : 'dry run';
  try {
    const report = await input.move({ workspaceId, fromTenantId, toTenantId, alsoContactIds: also }, apply);
    const blocked = report.blocked.length > 0 ? report.blocked.join(',') : 'none';
    // A dry run and a blocked apply changed nothing, so their line says "to", not "done".
    const done = report.written ? ['restamped', 'moved', 'repointed'] : ['to restamp', 'to move', 'to repoint'];
    log(
      `[workspace-move] ${label} for workspace ${workspaceId}: ${report.rows.restamp} of ${report.rows.rows} rows ${done[0]}, ` +
        `${report.contacts.move} contacts ${done[1]}, ${report.contacts.guestRowsRepointed} guest rows ${done[2]}, ` +
        `blocked: ${blocked}, written: ${report.written}`,
    );
    if (apply && report.blocked.length > 0) {
      return { status: 409, body: { error: 'Move blocked; nothing was written', report } };
    }
    return { status: 200, body: { ok: true, report } };
  } catch (e) {
    if (e instanceof WorkspaceMoveIncompleteError) {
      log(
        `[workspace-move] ${label} for workspace ${workspaceId} incomplete: ${e.contactsMoved} contacts moved, the rows were not restamped; repeat the call`,
      );
      return {
        status: 502,
        body: { error: 'Move incomplete; repeat the call to finish it', step: 'rows', contactsMoved: e.contactsMoved },
      };
    }
    log(`[workspace-move] ${label} for workspace ${workspaceId} failed (${(e as Error)?.name ?? 'error'})`);
    return { status: 502, body: { error: 'Move failed' } };
  }
}
