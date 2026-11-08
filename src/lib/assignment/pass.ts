import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Row } from '@marlinjai/data-table-core';
import { ensureRealTable } from '@marlinjai/data-table-adapter-prisma';
import { safeColumnName, safeTableName } from '@marlinjai/data-table-adapter-shared';
import { firstColumnIdByName } from '@/lib/column-lookup';
import { matchRules, statementsOf, type ClassificationRule } from '@/lib/classification-rules';
import { listRules } from '@/lib/classification-rules-store';
import { companiesWithReceipts } from '@/lib/line-items/backfill';
import { isoDay } from '@/lib/meals/record';
import { allReceiptRows, tableContext } from '@/lib/meals/service';
import { ClassifierUnavailableError, UnusableAnswerError, decideAssignment, type AssignmentAnswer } from '@/lib/receipt-classifier';
import { ITEM_COLUMN } from '@/lib/receipt-name';
import { MEAL_CATEGORY, PRIVATE_ZUORDNUNG } from '@/lib/receipts-constants';
import { rowsWithOwnTreatment } from '@/lib/tax/service';
import { buildAssignmentContext, contextFacts, type CorrectionEntry } from './context';
import { assignmentFingerprint } from './fingerprint';
import type { AssignmentContext, AssignmentLine, AssignmentReceipt, PastAnswer, Statement } from './prompt';

/**
 * Who bears a receipt's cost, decided by a model that learns the person (plan
 * docs/plans/2026-11-07-learned-assignment.md).
 *
 * For every receipt of a company whose assignment is open, this pass asks the
 * assignment model with what the app has learned about the person (their
 * statements, how they answered before, the corrections of the model's earlier
 * answers). A confident answer is written into the cell and marked as
 * automatic; an unsure one is kept as the suggestion "Belege prüfen" shows. A
 * failure sets nothing and is logged; the next run tries again.
 *
 * Who said what is told apart without a flag on the row: a cell holds an
 * automatic answer exactly while an applied decision exists for it, no answer
 * of a person is recorded, and the cell still holds what the decision wrote.
 * Anything else in a cell is a person's answer (typed in the table, set on a
 * review card, by "Set field", the chat, a meal marked as a business meal, a
 * finance decision) and is never overwritten. Where a person's answer differs
 * from what the model set or suggested, it is recorded as a correction and
 * shown to the model for later receipts; that receipt is never decided again.
 *
 * Every decision is keyed to the receipt's facts (`assignmentFingerprint`): a
 * new reading, a corrected vendor or new lines make an automatic answer count
 * for nothing, and the receipt is decided again (its cell cleared where the new
 * answer is not confident, so it is asked), never over a person's answer.
 *
 * Not decided here: a meal (the meal register judges it: an automatic "Privat"
 * would take it out of the Bewirtung list), a receipt a finance decision or a
 * finance vendor rule settles (the finance area writes its cells), and a
 * receipt a reading rule matches (decision 3: the rule wins, as at reading).
 *
 * Bounded per run (model calls), resumable (a failure is recorded with its
 * attempts and tried on a later run) and idempotent (a second run over the
 * same receipts asks nothing). Never throws for one receipt.
 */

export type AssignmentDecider = (receipt: AssignmentReceipt, context: AssignmentContext, options: readonly string[]) => Promise<AssignmentAnswer>;

export interface AssignmentDeps {
  decide: AssignmentDecider;
}

/**
 * At or above this confidence an answer is set automatically. Chosen by the replay over every receipt a
 * person had answered (decision 6, numbers in the plan's "Measured" section): the lowest threshold at which
 * neither wrong-way mistake ("Privat" on a business receipt, "Geschäftlich" on a private one) reaches 1 in 100
 * of the receipts it sets.
 */
export const AUTO_ASSIGN_CONFIDENCE = 0.9;
/**
 * The fingerprint of an answer the reader took from the document (#75) before the receipt's lines and item were
 * stored: the next pass keys it to the facts it finds, once, and decides nothing on it.
 */
export const READER_PENDING = 'reader-pending';
/** What the receipt panel says about an answer the reader took from the document. German: shown as it is. */
export const READER_REASON = 'Auf dem Beleg selbst zu sehen (an eine Firma oder Universität adressiert, mit Umsatzsteuer-ID oder Reverse Charge).';
/**
 * The outcome of a decision while its run writes the cell: claimed before the write, "set" once the cell
 * holds it. Another run leaves such a receipt alone, and never takes its cell for a person's answer.
 */
export const CLAIMING = 'claiming';
/** A claim older than this was left by a run that stopped between claim and write: it is settled from the cell. */
export const CLAIM_TTL_MS = 10 * 60_000;
/** A receipt the model failed to answer this often is asked about no more until its facts change. */
export const MAX_ASSIGNMENT_ATTEMPTS = 3;

/** Model calls per run, by where the run comes from. */
export const ASSIGNMENT_LIMITS = {
  /** After an upload, a retake, a new reading or an edit of the vendor: that receipt. */
  afterChange: 3,
  /** "Zuordnungen entscheiden" on the tools page: the page asks again while some are left. */
  request: 20,
  /** Daily, per company: only receipts whose decision failed before. */
  daily: 20,
} as const;

export interface AssignmentContextIds {
  workspaceId: string;
  tenantId: string | null;
}

export interface AssignmentRunResult {
  /** Receipts this run would decide (open, or automatic on facts that changed). */
  candidates: number;
  /** Receipts the model answered in this run. */
  decided: number;
  /** Of those, set automatically. */
  set: number;
  /** Of those, kept as a suggestion (unsure, or no option named). */
  suggested: number;
  /** Automatic answers whose facts changed and that are now asked again. */
  cleared: number;
  /** Model calls that failed in this run: tried again on a later run. */
  failed: number;
  /** Receipts left for a later run (the run's limit, or no model configured). */
  remaining: number;
  /** A person's answers recorded against an earlier decision (corrections or confirmations). */
  answersRecorded: number;
  /** Answers dropped because a person answered, or another run decided, while the model was asked. */
  superseded: number;
  /** True when no language model is configured: nothing was counted against a receipt. */
  unavailable: boolean;
}

const emptyResult = (): AssignmentRunResult => ({ candidates: 0, decided: 0, set: 0, suggested: 0, cleared: 0, failed: 0, remaining: 0, answersRecorded: 0, superseded: 0, unavailable: false });

/** One receipt as the pass looks at it. */
interface Snapshot {
  rowId: string;
  receipt: AssignmentReceipt;
  /** The option id the cell holds, null when it is empty. */
  cell: string | null;
  /** The option's name, null when empty (or an id no option has any more). */
  assignment: string | null;
}

type Decision = Prisma.ReceiptAssignmentDecisionGetPayload<object>;

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** True when the cell holds what an applied decision wrote, and no person has answered since. */
export function isAutomatic(decision: Pick<Decision, 'outcome' | 'assignment' | 'answeredAt'> | undefined, assignment: string | null): boolean {
  // A claim in flight counts too: the cell may hold its value a moment before the claim becomes "set".
  return Boolean(decision && (decision.outcome === 'set' || decision.outcome === CLAIMING) && !decision.answeredAt && decision.assignment && decision.assignment === assignment);
}

/** The corrections the model is shown: a person's answer that differs from the model's. */
function correctionsOf(decisions: readonly Decision[], snapshots: ReadonlyMap<string, Snapshot>): CorrectionEntry[] {
  const out: CorrectionEntry[] = [];
  for (const d of decisions) {
    if (!d.answeredAt || !d.answeredAs || d.answeredAs === d.assignment) continue;
    if (d.outcome !== 'set' && d.outcome !== 'suggested') continue;
    const s = snapshots.get(d.rowId);
    if (!s) continue;
    out.push({ rowId: d.rowId, vendor: s.receipt.vendor ?? '', date: s.receipt.date, category: s.receipt.category, item: s.receipt.item, modelSaid: d.assignment, how: d.outcome, personSaid: d.answeredAs });
  }
  return out;
}

export async function decideAssignments(
  db: PrismaClient,
  ctx: AssignmentContextIds,
  deps: AssignmentDeps,
  /** `deadline` (milliseconds since the epoch): a run asks no more model calls after it, the rest is `remaining`. */
  options: { only?: readonly string[]; limit?: number; failedOnly?: boolean; deadline?: number; now?: () => Date } = {},
): Promise<AssignmentRunResult> {
  const result = emptyResult();
  const now = options.now ?? (() => new Date());
  let budget = Math.max(0, options.limit ?? ASSIGNMENT_LIMITS.request);

  const table = await tableContext(db, ctx.workspaceId);
  if (!table) return result;
  const byName = firstColumnIdByName(table.columns);
  const zuordnungId = byName.get('Zuordnung');
  if (!zuordnungId) return result;
  const optionsOf = (name: string) => {
    const id = byName.get(name);
    return id ? (table.selectOptions.get(id) ?? []) : [];
  };
  const assignmentOptions = optionsOf('Zuordnung');
  if (assignmentOptions.length === 0) return result;
  const optionName = (columnName: string, value: unknown) => (typeof value === 'string' && value ? (optionsOf(columnName).find((o) => o.id === value)?.name ?? null) : null);
  const optionIdOf = (name: string) => assignmentOptions.find((o) => o.name === name)?.id ?? null;
  const cell = (row: Row, name: string): unknown => {
    const id = byName.get(name);
    return id ? row.cells[id] : undefined;
  };

  const rows = await allReceiptRows(table.adapter, table.tableId, table.columns);
  if (rows.length === 0) return result;
  const items = await db.receiptItem.findMany({
    where: { authWorkspaceId: ctx.workspaceId },
    select: { rowId: true, text: true, grossCents: true, kind: true, position: true },
    orderBy: [{ rowId: 'asc' }, { position: 'asc' }],
  });
  const linesByRow = new Map<string, AssignmentLine[]>();
  for (const i of items) linesByRow.set(i.rowId, [...(linesByRow.get(i.rowId) ?? []), { text: i.text, grossCents: i.grossCents, kind: i.kind }]);

  const snapshots = new Map<string, Snapshot>();
  for (const row of rows) {
    const raw = cell(row, 'Zuordnung');
    const cellValue = typeof raw === 'string' && raw ? raw : null;
    snapshots.set(row.id, {
      rowId: row.id,
      cell: cellValue,
      assignment: optionName('Zuordnung', cellValue),
      receipt: {
        vendor: text(cell(row, 'Vendor')).trim() || null,
        date: isoDay(cell(row, 'Date')),
        category: optionName('Category', cell(row, 'Category')),
        item: text(cell(row, ITEM_COLUMN)).trim() || null,
        gross: num(cell(row, 'Gross')),
        currency: optionName('Currency', cell(row, 'Currency')) ?? 'EUR',
        lines: linesByRow.get(row.id) ?? [],
        text: text(cell(row, 'OCR Text')),
      },
    });
  }

  let rules: ClassificationRule[] = [];
  try {
    rules = await listRules(db, ctx.workspaceId);
  } catch (err) {
    // Without the rules no receipt can be told apart from one a rule decides: nothing is decided this run.
    console.error('[assignment] loading the rules failed:', err instanceof Error ? err.name : 'error');
    return result;
  }
  const statements: Statement[] = statementsOf(rules).map((r) => ({ id: r.id, text: r.matchValue, assignment: r.zuordnung }));
  const ruleMatched = (s: Snapshot) => matchRules(rules, { vendor: s.receipt.vendor, fullText: s.receipt.text }) !== null;

  const decisionList = await db.receiptAssignmentDecision.findMany({ where: { authWorkspaceId: ctx.workspaceId } });
  const decisions = new Map(decisionList.map((d) => [d.rowId, d]));

  // ── 1. The answers persons gave since a decision: recorded once, never decided again ──────────────
  for (const s of snapshots.values()) {
    let d = decisions.get(s.rowId);
    if (!d || d.answeredAt) continue;
    if (d.outcome === CLAIMING) {
      // In flight in another run: not an answer, not decided here.
      if (now().getTime() - d.decidedAt.getTime() < CLAIM_TTL_MS) continue;
      // Left behind by a run that stopped: the cell says whether the write happened.
      const settledAs = s.assignment !== null && s.assignment === d.assignment ? 'set' : 'failed';
      try {
        const { count } = await db.receiptAssignmentDecision.updateMany({ where: { rowId: s.rowId, decidedAt: d.decidedAt, outcome: CLAIMING }, data: { outcome: settledAs, ...(settledAs === 'failed' ? { attempts: d.attempts + 1 } : {}) } });
        if (count === 0) continue;
        d = { ...d, outcome: settledAs, attempts: settledAs === 'failed' ? d.attempts + 1 : d.attempts };
        decisions.set(s.rowId, d);
      } catch (err) {
        console.error('[assignment] a claim left behind could not be settled:', err instanceof Error ? err.name : 'error');
        continue;
      }
    }
    const answered =
      // An automatic answer that the cell no longer holds: changed or emptied by a person.
      (d.outcome === 'set' && s.assignment !== d.assignment) ||
      // A suggestion (or a failure) the person answered.
      (d.outcome !== 'set' && s.assignment !== null);
    if (!answered) continue;
    try {
      const updated = await db.receiptAssignmentDecision.updateMany({ where: { rowId: s.rowId, answeredAt: null }, data: { answeredAs: s.assignment, answeredAt: now() } });
      if (updated.count > 0) {
        result.answersRecorded++;
        decisions.set(s.rowId, { ...d, answeredAs: s.assignment, answeredAt: now() });
      }
    } catch (err) {
      console.error('[assignment] a person\'s answer could not be recorded:', err instanceof Error ? err.name : 'error');
    }
  }

  // ── 2. What the model is given: the person's own answers and the corrections ────────────────────────
  const history: PastAnswer[] = [];
  for (const s of snapshots.values()) {
    if (!s.assignment || isAutomatic(decisions.get(s.rowId), s.assignment) || ruleMatched(s)) continue;
    history.push({ rowId: s.rowId, vendor: s.receipt.vendor ?? '', date: s.receipt.date, category: s.receipt.category, item: s.receipt.item, lines: s.receipt.lines.map((l) => l.text), assignment: s.assignment });
  }
  const corrections = correctionsOf([...decisions.values()], snapshots);

  // ── 3. The receipts to decide ───────────────────────────────────────────────────────────────────────
  const only = options.only ? new Set(options.only) : null;
  const scoped = [...snapshots.values()].filter((s) => !only || only.has(s.rowId));
  const settled = await rowsWithOwnTreatment(db, ctx.workspaceId, scoped.map((s) => ({ rowId: s.rowId, vendor: s.receipt.vendor ?? '', date: s.receipt.date })));
  const candidates: Array<{ s: Snapshot; fingerprint: string; staleAuto: boolean }> = [];
  // Rows whose cell this run wrote, for the share to follow; and those of them that left "Privat".
  const written: string[] = [];
  const leftPrivate: string[] = [];
  for (const s of scoped) {
    const d = decisions.get(s.rowId);
    if (d?.answeredAt) continue;
    // Another run is writing this receipt's cell right now.
    if (d?.outcome === CLAIMING) continue;
    const auto = isAutomatic(d, s.assignment);
    if (s.assignment !== null && !auto) continue;
    const fingerprint = assignmentFingerprint(s.receipt);
    // The reader's answer from the document: keyed to the facts now stored, never decided again on them.
    // Also on a meal or a settled receipt, so no record stays pending for good.
    if (auto && d?.fingerprint === READER_PENDING) {
      await db.receiptAssignmentDecision.updateMany({ where: { rowId: s.rowId, fingerprint: READER_PENDING }, data: { fingerprint } }).catch((err) => console.error('[assignment] a reader answer could not be keyed:', err instanceof Error ? err.name : 'error'));
      continue;
    }
    if (s.receipt.category === MEAL_CATEGORY || settled.has(s.rowId)) continue;
    if (ruleMatched(s)) {
      // A reading rule decides it (decision 3); an automatic answer it contradicts gives way to the rule.
      if (auto && (await giveWayToRule(db, ctx, table.tableId, zuordnungId, s, rules, optionIdOf, result))) {
        written.push(s.rowId);
        if (s.assignment === PRIVATE_ZUORDNUNG) leftPrivate.push(s.rowId);
      }
      continue;
    }
    const current = d && d.fingerprint === fingerprint ? d : null;
    if (auto && current) continue;
    // Decided on these very facts already: a suggestion and a receipt the model kept failing on are not asked again.
    if (current && (current.outcome === 'suggested' || (current.outcome === 'failed' && current.attempts >= MAX_ASSIGNMENT_ATTEMPTS))) continue;
    if (options.failedOnly && d?.outcome !== 'failed') continue;
    candidates.push({ s, fingerprint, staleAuto: auto });
  }
  // The oldest first: the pass over every open receipt goes in the order the person would.
  candidates.sort((a, b) => (a.s.receipt.date ?? '9999').localeCompare(b.s.receipt.date ?? '9999'));
  result.candidates = candidates.length;

  for (const { s, fingerprint, staleAuto } of candidates) {
    if (result.unavailable || budget <= 0 || (options.deadline !== undefined && now().getTime() > options.deadline)) {
      result.remaining++;
      continue;
    }
    const prior = decisions.get(s.rowId);
    const priorAttempts = prior && prior.fingerprint === fingerprint && prior.outcome === 'failed' ? prior.attempts : 0;
    // What the cell may hold for this write: empty, or the automatic answer that is now outdated.
    const replaceable = staleAuto ? s.cell : null;
    budget--;
    // What this run claimed and wrote, for the failure path to build on and take back.
    let claimed: Date | null = null;
    let wroteValue: string | null = null;
    try {
      const context = buildAssignmentContext({ rowId: s.rowId, vendor: s.receipt.vendor, category: s.receipt.category }, history, statements, corrections);
      const answer = await deps.decide(s.receipt, context, assignmentOptions.map((o) => o.name));
      result.decided++;
      const optionId = answer.assignment ? optionIdOf(answer.assignment) : null;
      const decided = { fingerprint, assignment: answer.assignment, confidence: answer.confidence, reason: answer.reason || null, model: answer.model, facts: contextFacts(context) as Prisma.InputJsonValue, attempts: 0 };
      const settingIt = Boolean(optionId) && answer.confidence >= AUTO_ASSIGN_CONFIDENCE;
      // The decision is claimed first, and only over the record this run read: a person who answered during the
      // model call, or another run that decided meanwhile, keeps what they wrote and this answer is dropped.
      // An answer to set is claimed as in flight; it is "set" only once the cell holds it.
      claimed = await recordDecision(db, ctx, s.rowId, { ...decided, outcome: settingIt ? CLAIMING : 'suggested' }, prior ?? null);
      if (!claimed) {
        result.superseded++;
        continue;
      }
      if (settingIt) {
        // Only over an empty cell or the outdated automatic answer: a person who answered meanwhile wins.
        if (await writeCell(db, table.tableId, zuordnungId, s.rowId, optionId, replaceable)) {
          wroteValue = optionId;
          const { count } = await db.receiptAssignmentDecision.updateMany({ where: { rowId: s.rowId, decidedAt: claimed, answeredAt: null }, data: { outcome: 'set' } });
          if (count === 0) {
            // A person answered between the write and here: their answer stands, the write is taken back.
            await writeCell(db, table.tableId, zuordnungId, s.rowId, replaceable, optionId);
            result.superseded++;
            continue;
          }
          result.set++;
          written.push(s.rowId);
          if (staleAuto && s.assignment === PRIVATE_ZUORDNUNG && answer.assignment !== PRIVATE_ZUORDNUNG) leftPrivate.push(s.rowId);
        } else {
          // The cell changed under it: the claim is no set answer, only what was suggested.
          await db.receiptAssignmentDecision.updateMany({ where: { rowId: s.rowId, decidedAt: claimed }, data: { outcome: 'suggested' } });
          result.suggested++;
        }
        continue;
      }
      result.suggested++;
      // The automatic answer rested on facts that changed, and the new one is not sure: it is asked.
      if (staleAuto && (await writeCell(db, table.tableId, zuordnungId, s.rowId, null, replaceable))) {
        result.cleared++;
        written.push(s.rowId);
      }
    } catch (err) {
      if (err instanceof ClassifierUnavailableError) {
        result.unavailable = true;
        result.remaining++;
        budget++;
        continue;
      }
      result.failed++;
      // The message only: an error of the client library can carry the request, and with it the receipt.
      console.error('[assignment] a receipt could not be decided:', err instanceof Error ? `${err.name}${err instanceof UnusableAnswerError ? `: ${err.message}` : ''}` : 'error');
      try {
        // A failure never sets anything: over this run's own claim where it made one, else over what it read. A value
        // it wrote is taken back, and an automatic answer on outdated facts too, so the receipt is asked.
        const base = claimed ? { decidedAt: claimed } : (prior ?? null);
        const failed = await recordDecision(db, ctx, s.rowId, { fingerprint, outcome: 'failed', assignment: null, confidence: null, reason: null, model: null, facts: null, attempts: priorAttempts + 1 }, base);
        if (failed && wroteValue !== null) await writeCell(db, table.tableId, zuordnungId, s.rowId, null, wroteValue);
        if (failed && staleAuto && (await writeCell(db, table.tableId, zuordnungId, s.rowId, null, replaceable))) {
          result.cleared++;
          written.push(s.rowId);
        }
      } catch (e) {
        console.error('[assignment] the failure could not be recorded:', e instanceof Error ? e.name : 'error');
      }
    }
  }

  // A private receipt shows share 0, a business one its default: the cells follow (src/lib/tax/assignment-sync.ts).
  if (written.length > 0) {
    const { followTreatment, restoreShareLeavingPrivate } = await import('@/lib/tax/assignment-sync');
    // Leaving "Privat" brings back the share it held before, as a manual edit does.
    // Each on its own: the cells and decisions are written, a failure here only leaves a share to the next sync.
    await restoreShareLeavingPrivate(db, ctx, leftPrivate).catch((err) => console.error('[assignment] the share could not be restored:', err instanceof Error ? err.name : 'error'));
    await followTreatment(db, ctx, { rowIds: written }).catch((err) => console.error('[assignment] the treatment could not follow:', err instanceof Error ? err.name : 'error'));
  }
  if (result.candidates > 0 || result.answersRecorded > 0) console.info('[assignment] run', result);
  return result;
}

/**
 * Record a decision, only over the record the run read (`prior`, matched by its `decidedAt`, and only while no
 * person's answer is on it); a new record only where there is none. Returns the new record's `decidedAt`,
 * or null when somebody else wrote one meanwhile: then nothing is recorded.
 */
async function recordDecision(
  db: PrismaClient,
  ctx: AssignmentContextIds,
  rowId: string,
  d: { fingerprint: string; outcome: 'set' | 'suggested' | 'failed' | typeof CLAIMING; assignment: string | null; confidence: number | null; reason: string | null; model: string | null; facts: Prisma.InputJsonValue | null; attempts: number },
  prior: Pick<Decision, 'decidedAt'> | null,
): Promise<Date | null> {
  const decidedAt = new Date();
  const data = { ...d, facts: d.facts ?? undefined, decidedAt, answeredAs: null, answeredAt: null };
  if (prior) {
    const { count } = await db.receiptAssignmentDecision.updateMany({ where: { rowId, decidedAt: prior.decidedAt, answeredAt: null }, data });
    return count > 0 ? decidedAt : null;
  }
  try {
    await db.receiptAssignmentDecision.create({ data: { rowId, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, ...data } });
    return decidedAt;
  } catch (err) {
    // Another run created it first.
    if ((err as { code?: string }).code === 'P2002') return null;
    throw err;
  }
}

/**
 * Write the assignment cell only where it still holds what the pass saw: empty, or the outdated
 * automatic answer. True when the row was written. One statement, so a person's answer that arrived
 * between the read and this write is never overwritten.
 */
async function writeCell(db: PrismaClient, tableId: string, columnId: string, rowId: string, value: string | null, replaceable: string | null): Promise<boolean> {
  await ensureRealTable(db, tableId);
  const col = safeColumnName(columnId);
  const held = replaceable === null ? `(${col} IS NULL OR ${col} = '')` : `${col} = $4`;
  const params: unknown[] = [value, new Date().toISOString(), rowId];
  if (replaceable !== null) params.push(replaceable);
  const count = await db.$executeRawUnsafe(`UPDATE ${safeTableName(tableId)} SET ${col} = $1, _updated_at = $2 WHERE id = $3 AND _archived = 0 AND ${held}`, ...params);
  return count > 0;
}

/** A reading rule now matches a receipt the model had decided: the rule's answer stands, the decision goes. */
async function giveWayToRule(
  db: PrismaClient,
  ctx: AssignmentContextIds,
  tableId: string,
  columnId: string,
  s: Snapshot,
  rules: readonly ClassificationRule[],
  optionIdOf: (name: string) => string | null,
  result: AssignmentRunResult,
): Promise<boolean> {
  const match = matchRules(rules, { vendor: s.receipt.vendor, fullText: s.receipt.text });
  const optionId = match ? optionIdOf(match.zuordnung) : null;
  try {
    // Only over the automatic answer the run saw; a person's answer since stays, and so does its record.
    const wrote = optionId !== null && optionId !== s.cell && (await writeCell(db, tableId, columnId, s.rowId, optionId, s.cell));
    if (wrote || optionId === s.cell) await db.receiptAssignmentDecision.deleteMany({ where: { rowId: s.rowId, authWorkspaceId: ctx.workspaceId, answeredAt: null } });
    return wrote;
  } catch (err) {
    result.failed++;
    console.error('[assignment] a rule could not take over a receipt:', err instanceof Error ? err.name : 'error');
    return false;
  }
}

/**
 * The assignment the reader took from the document itself (#75), written into the cell by the reading:
 * recorded as an automatic answer, so a person's change of it is a correction and it never counts as the
 * person's own answer. A receipt a person has answered keeps its record.
 */
export async function recordReaderAssignment(db: PrismaClient, ctx: AssignmentContextIds, rowId: string, read: { assignment: string; model: string }): Promise<void> {
  try {
    const existing = await db.receiptAssignmentDecision.findUnique({ where: { rowId } });
    if (existing?.answeredAt) return;
    // Over the record just read, or a new one: never over an answer a person gave in between.
    await recordDecision(db, ctx, rowId, { fingerprint: READER_PENDING, outcome: 'set', assignment: read.assignment, confidence: null, reason: READER_REASON, model: read.model, facts: { source: 'reader' }, attempts: 0 }, existing);
  } catch (err) {
    console.error('[assignment] the reader\'s answer could not be recorded:', err instanceof Error ? err.name : 'error');
  }
}

/** The model call of the server. */
export function serverAssignmentDeps(): AssignmentDeps {
  return { decide: decideAssignment };
}

/**
 * The pass for some receipts after they changed (an upload, a retake, a new
 * reading, an edit of the vendor), without failing what changed them: run
 * after the answer, a failure is logged and the next run catches up.
 */
export async function decideAssignmentsAfterChange(db: PrismaClient, ctx: AssignmentContextIds, rowIds: readonly string[], deps?: AssignmentDeps): Promise<AssignmentRunResult | null> {
  try {
    return await decideAssignments(db, ctx, deps ?? serverAssignmentDeps(), { only: rowIds, limit: ASSIGNMENT_LIMITS.afterChange });
  } catch (err) {
    console.error('[assignment] the pass after a change failed:', err instanceof Error ? err.name : 'error');
    return null;
  }
}

/**
 * Record a person's answer for receipts whose assignment cell was just written by a person (a table
 * edit, "Set field", a review card): a correction where it differs from the model's, and never decided
 * again. The pass also finds such answers on its own (step 1); this records them when they are given.
 */
export async function recordAssignmentAnswers(db: PrismaClient, ctx: AssignmentContextIds, answers: ReadonlyArray<{ rowId: string; assignment: string | null }>, now: () => Date = () => new Date()): Promise<void> {
  if (answers.length === 0) return;
  try {
    const open = await db.receiptAssignmentDecision.findMany({ where: { authWorkspaceId: ctx.workspaceId, rowId: { in: answers.map((a) => a.rowId) }, answeredAt: null } });
    for (const d of open) {
      const given = answers.find((a) => a.rowId === d.rowId)!.assignment;
      // The automatic answer written again is no answer of the person; anything else is.
      if ((d.outcome === 'set' || d.outcome === CLAIMING) && given === d.assignment) continue;
      if (d.outcome !== 'set' && given === null) continue;
      await db.receiptAssignmentDecision.updateMany({ where: { rowId: d.rowId, answeredAt: null }, data: { answeredAs: given, answeredAt: now() } });
    }
  } catch (err) {
    console.error('[assignment] a person\'s answer could not be recorded:', err instanceof Error ? err.name : 'error');
  }
}

/** The daily run: every company in turn, only the receipts whose decision failed before (the resume path). */
export async function dailyAssignmentRetry(db: PrismaClient, deps: AssignmentDeps, options: { companies?: AssignmentContextIds[] } = {}): Promise<void> {
  for (const company of options.companies ?? (await companiesWithReceipts(db))) {
    try {
      const failedBefore = await db.receiptAssignmentDecision.count({ where: { authWorkspaceId: company.workspaceId, outcome: 'failed' } });
      if (failedBefore === 0) continue;
      const run = await decideAssignments(db, company, deps, { failedOnly: true, limit: ASSIGNMENT_LIMITS.daily });
      if (run.unavailable) break;
    } catch (err) {
      console.error('[assignment] the daily run failed for a company:', err instanceof Error ? err.name : 'error');
    }
  }
}

/** What the review card and the receipt panel show about a receipt's assignment decision. */
export interface AssignmentNote {
  /** 'set': the cell holds the model's answer. 'suggested': the model's answer, not set. */
  kind: 'set' | 'suggested';
  assignment: string | null;
  confidence: number | null;
  reason: string | null;
}

/**
 * The notes for some receipts: an automatic answer the cell still holds, or a suggestion for a receipt
 * still open. Nothing for a receipt a person answered, or whose decision rests on facts that changed.
 */
export async function assignmentNotes(
  db: PrismaClient,
  workspaceId: string,
  rows: ReadonlyArray<{ rowId: string; assignment: string | null; receipt?: AssignmentReceipt }>,
): Promise<Map<string, AssignmentNote>> {
  const out = new Map<string, AssignmentNote>();
  if (rows.length === 0) return out;
  const decisions = await db.receiptAssignmentDecision.findMany({ where: { authWorkspaceId: workspaceId, rowId: { in: rows.map((r) => r.rowId) }, answeredAt: null, outcome: { in: ['set', 'suggested'] } } });
  const byRow = new Map(rows.map((r) => [r.rowId, r]));
  for (const d of decisions) {
    const row = byRow.get(d.rowId);
    if (!row) continue;
    if (row.receipt && d.fingerprint !== READER_PENDING && assignmentFingerprint(row.receipt) !== d.fingerprint) continue;
    if (d.outcome === 'set' && isAutomatic(d, row.assignment)) out.set(d.rowId, { kind: 'set', assignment: d.assignment, confidence: d.confidence, reason: d.reason });
    if (d.outcome === 'suggested' && row.assignment === null && d.assignment) out.set(d.rowId, { kind: 'suggested', assignment: d.assignment, confidence: d.confidence, reason: d.reason });
  }
  return out;
}
