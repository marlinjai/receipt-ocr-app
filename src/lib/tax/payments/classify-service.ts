import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { getTaxSettings } from '@/lib/meals/service';
import { resolveItem } from '../facts';
import { listVendorRules, loadReceipts } from '../service';
import { capModelVerdict, evidenceFingerprint, evidenceVerdict, toModelCounterparty, type CounterpartyEvidence, type DecidedVerdict } from './classify';
import type { CounterpartyClassifierPort } from './counterparty-classifier';
import { loadPayments, type LoadedPayments } from './service';

/**
 * Deciding the counterparties of one company without a person (plan
 * docs/plans/2026-10-25-auto-classify-payments.md, decisions 3 and 6).
 *
 * Asked about is every counterparty with payments that nothing has decided
 * yet: no person's answer, no own name, no verdict, or a verdict whose
 * evidence (the receipts linked to it) changed since. The company's own data
 * decides first; the model gets only the rest, in batches, largest sums first,
 * at most `limit` per run, so a long history is worked down over a few runs.
 * Every verdict is stored, also a likely or unsure one, so nothing is asked
 * twice; only a certain one counts (`verdicts.ts`).
 */

export interface ClassifyContext {
  workspaceId: string;
  tenantId: string | null;
}

export interface ClassifyRun {
  /** Counterparties that were still undecided before the run. */
  pending: number;
  /** Decided in this run from the company's own data, and by the model. */
  byEvidence: number;
  byModel: number;
  /** Of all decided in this run, how many count right away (certain). */
  applied: number;
  /** The model could not be asked: none configured. Counterparties the data could not decide stay open. */
  unavailable: boolean;
  /** Batches whose call failed; their counterparties stay open and are asked on a later run. */
  failedBatches: number;
}

export const CLASSIFY_LIMIT = 100;
export const CLASSIFY_BATCH = 20;

/** What is known about each counterparty of the company that may need a verdict. */
export async function counterpartyEvidence(db: PrismaClient, workspaceId: string, loaded: LoadedPayments): Promise<CounterpartyEvidence[]> {
  const [receipts, vendorRules, settings] = await Promise.all([loadReceipts(db, workspaceId), listVendorRules(db, workspaceId), getTaxSettings(db, workspaceId)]);
  // How each receipt is allocated: all business (or the job and study annexes, also deductible), all private, or both.
  const allocationOf = new Map<string, { kind: 'business' | 'private' | 'mixed'; category: string | null }>();
  for (const f of receipts?.facts ?? []) {
    const allocations = resolveItem({ ...f, countsOnDay: null }, vendorRules, settings).item.allocations;
    if (!allocations || allocations.length === 0) continue;
    const privateBp = allocations.filter((a) => a.purpose === 'private').reduce((s, a) => s + a.shareBp, 0);
    const otherBp = allocations.filter((a) => a.purpose !== 'private').reduce((s, a) => s + a.shareBp, 0);
    const kind = otherBp > 0 && privateBp > 0 ? 'mixed' : otherBp > 0 ? 'business' : 'private';
    allocationOf.set(f.record.rowId, { kind, category: f.record.category ?? null });
  }
  const privateAccounts = new Set(loaded.accounts.filter((a) => a.isPrivate).map((a) => a.id));
  const byKey = new Map<string, CounterpartyEvidence & { rows: Set<string>; allPrivate: boolean }>();
  for (const p of loaded.payments) {
    // What asks nothing in the payments tab asks nothing here either: own transfers, fees, the funding rule's
    // debits, and payments of an account said to be private as a whole (the owner already answered for them).
    if (!p.counterpartyKey || p.kind === 'own_transfer' || p.kind === 'fee' || p.kind === 'private' || p.byRule) continue;
    const entry = byKey.get(p.counterpartyKey) ?? {
      key: p.counterpartyKey,
      label: p.counterparty,
      paymentCount: 0,
      outCents: 0,
      inCents: 0,
      samples: [],
      onPrivateAccount: false,
      receipts: { business: 0, private: 0, mixed: 0, categories: [] },
      rows: new Set<string>(),
      allPrivate: true,
    };
    entry.paymentCount += 1;
    if (p.amountCents < 0) entry.outCents += -p.amountCents;
    else entry.inCents += p.amountCents;
    const text = p.reference.trim();
    if (text && entry.samples.length < 3 && !entry.samples.includes(text)) entry.samples.push(text);
    if (!privateAccounts.has(p.accountId)) entry.allPrivate = false;
    for (const link of p.links) if (link.rowId) entry.rows.add(link.rowId);
    byKey.set(p.counterpartyKey, entry);
  }
  return [...byKey.values()].map(({ rows, allPrivate, ...evidence }) => {
    for (const rowId of rows) {
      const allocation = allocationOf.get(rowId);
      if (!allocation) continue;
      evidence.receipts[allocation.kind] += 1;
      if (allocation.category) evidence.receipts.categories.push(allocation.category);
    }
    return { ...evidence, onPrivateAccount: allPrivate };
  });
}

/**
 * The counterparties a run would ask about, largest sums first: nothing decided
 * them yet (no person, no own name), and they have no verdict or one made on
 * evidence that has changed since.
 */
export function pendingCounterparties(evidence: readonly CounterpartyEvidence[], loaded: Pick<LoadedPayments, 'treatmentSources'>, fingerprints: ReadonlyMap<string, string>): CounterpartyEvidence[] {
  return evidence
    .filter((e) => {
      const source = loaded.treatmentSources.get(e.key);
      if (source === 'person' || source === 'own_name') return false;
      return fingerprints.get(e.key) !== evidenceFingerprint(e);
    })
    .sort((a, b) => b.outCents + b.inCents - (a.outCents + a.inCents) || a.key.localeCompare(b.key));
}

async function store(db: PrismaClient, ctx: ClassifyContext, evidence: CounterpartyEvidence, verdict: DecidedVerdict, source: 'evidence' | 'model', model: string | null): Promise<void> {
  const data = {
    label: evidence.label,
    treatment: verdict.treatment,
    category: verdict.category,
    confidence: verdict.confidence,
    reason: verdict.reason,
    source,
    model,
    fingerprint: evidenceFingerprint(evidence),
  };
  await db.taxCounterpartyVerdict.upsert({
    where: { authWorkspaceId_counterpartyKey: { authWorkspaceId: ctx.workspaceId, counterpartyKey: evidence.key } },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, counterpartyKey: evidence.key, ...data },
    update: data,
  });
}

/** What is stored for a counterparty the model was asked about and gave no usable answer for: not asked again until its evidence changes. */
const NO_ANSWER: DecidedVerdict = { treatment: null, category: null, confidence: 'unsure', reason: 'Keine verwertbare Antwort erhalten.' };

/**
 * One run: decide what the data decides, ask the model about the rest (when one
 * is configured), store every verdict. A failed batch is logged and counted,
 * never retried in the same run; its counterparties stay open.
 */
export async function classifyCounterparties(
  db: PrismaClient,
  ctx: ClassifyContext,
  port: CounterpartyClassifierPort | null,
  options: { limit?: number; batch?: number } = {},
): Promise<ClassifyRun> {
  const loaded = await loadPayments(db, ctx.workspaceId);
  const stored = await db.taxCounterpartyVerdict.findMany({ where: { authWorkspaceId: ctx.workspaceId }, select: { counterpartyKey: true, fingerprint: true, source: true } });
  const pending = pendingCounterparties(await counterpartyEvidence(db, ctx.workspaceId, loaded), loaded, new Map(stored.map((s) => [s.counterpartyKey, s.fingerprint])));
  const storedSource = new Map(stored.map((s) => [s.counterpartyKey, s.source]));
  const run: ClassifyRun = { pending: pending.length, byEvidence: 0, byModel: 0, applied: 0, unavailable: port === null, failedBatches: 0 };
  if (port === null && pending.length > 0) console.warn('[payments] no language model configured: counterparties are decided by their receipts only', { workspaceId: ctx.workspaceId, pending: pending.length });
  const toModel: CounterpartyEvidence[] = [];
  for (const evidence of pending.slice(0, options.limit ?? CLASSIFY_LIMIT)) {
    const verdict = evidenceVerdict(evidence);
    if (!verdict) {
      // A verdict the receipts made no longer holds now that they say something else: it stops counting at once,
      // whether or not the model can be asked right now.
      if (storedSource.get(evidence.key) === 'evidence') {
        await db.taxCounterpartyVerdict.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, counterpartyKey: evidence.key } });
      }
      toModel.push(evidence);
      continue;
    }
    await store(db, ctx, evidence, verdict, 'evidence', null);
    run.byEvidence += 1;
    run.applied += 1;
  }
  if (!port) return run;
  const size = options.batch ?? CLASSIFY_BATCH;
  for (let i = 0; i < toModel.length; i += size) {
    const batch = toModel.slice(i, i + size);
    let verdicts: Map<string, DecidedVerdict>;
    try {
      verdicts = await port.classify(batch.map(toModelCounterparty));
    } catch (e) {
      console.error('[payments] classifying counterparties failed', { workspaceId: ctx.workspaceId, batch: batch.length, error: e instanceof Error ? e.message : String(e) });
      run.failedBatches += 1;
      continue;
    }
    for (const evidence of batch) {
      const answered = verdicts.get(evidence.key);
      // No usable answer for it (left out, garbled): stored as unsure, so it is not paid for again on every run.
      const verdict = answered ? capModelVerdict(answered, evidence) : NO_ANSWER;
      await store(db, ctx, evidence, verdict, 'model', port.model);
      if (!answered) continue;
      run.byModel += 1;
      if (verdict.confidence === 'certain' && verdict.treatment !== null) run.applied += 1;
    }
  }
  return run;
}
