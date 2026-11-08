import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellValue } from '@marlinjai/data-table-core';
import { ClassifierUnavailableError, type AssignmentAnswer } from '@/lib/receipt-classifier';
import { loadReviewQueue } from '@/lib/review/service';
import { deleteReceiptRows, saveMealDetails } from '@/lib/meals/service';
import { createWorkspace, db, type TestWorkspace } from '../../../../test/db-helpers';
import { AUTO_ASSIGN_CONFIDENCE, CLAIMING, CLAIM_TTL_MS, MAX_ASSIGNMENT_ATTEMPTS, READER_PENDING, assignmentNotes, decideAssignments, recordAssignmentAnswers, recordReaderAssignment, type AssignmentDeps } from '../pass';
import type { AssignmentContext, AssignmentReceipt } from '../prompt';

/**
 * The assignment pass against a real database (plan
 * docs/plans/2026-11-07-learned-assignment.md), through the four paths of the
 * flow. Forward: an open receipt is decided, a confident answer set, an unsure
 * one kept as the suggestion. Backtrack: a person's change is recorded as a
 * correction and never decided again; a re-read or a changed vendor makes an
 * automatic answer count for nothing and the receipt is decided again, never
 * over a person's answer. Resume: a failure sets nothing and is tried again.
 * Re-entry: a second run asks nothing. Every model call is faked.
 * Run with `pnpm test:db`.
 */

let ws: TestWorkspace;
let ctx: { workspaceId: string; tenantId: string | null };
let col: (name: string) => string;

const decide = vi.fn<(receipt: AssignmentReceipt, context: AssignmentContext, options: readonly string[]) => Promise<AssignmentAnswer>>();
const deps: AssignmentDeps = { decide };
const answer = (assignment: string | null, confidence: number, reason = 'Drogerie: bisher immer privat.'): AssignmentAnswer => ({ assignment, confidence, reason, model: 'test/assignment-model', usage: { inputTokens: 1, outputTokens: 1, cost: null } });

const receipt = (cells: Record<string, CellValue> = {}) =>
  ws.addReceipt({ Name: 'Rossmann', Vendor: 'Rossmann', Gross: 4.99, Date: '2026-11-06', Category: 'Sonstige Ausgaben', Currency: 'EUR', 'FX Rate': 1, Item: 'Schokolade', 'OCR Text': 'Rossmann\nSchokolade 4,99', ...cells });

const optionId = async (name: string) => (await ws.adapter.getSelectOptions(col('Zuordnung'))).find((o) => o.name === name)!.id;
const assignmentOf = async (rowId: string) => {
  const id = (await ws.adapter.getRow(rowId))!.cells[col('Zuordnung')];
  return typeof id === 'string' && id ? ((await ws.adapter.getSelectOptions(col('Zuordnung'))).find((o) => o.id === id)?.name ?? null) : null;
};
/** A person sets the cell, as a table edit does. */
const personSets = async (rowId: string, name: string | null) => {
  await ws.adapter.updateRow(rowId, { [col('Zuordnung')]: name ? await optionId(name) : null });
  await recordAssignmentAnswers(db, ctx, [{ rowId, assignment: name }]);
};
const decisionOf = (rowId: string) => db.receiptAssignmentDecision.findUnique({ where: { rowId } });
const run = (options: Parameters<typeof decideAssignments>[3] = {}) => decideAssignments(db, ctx, deps, { limit: 10, ...options });
const entryFor = async (rowId: string) => (await loadReviewQueue(db, ws.workspaceId)).find((e) => e.rowId === rowId);

beforeEach(async () => {
  ws = await createWorkspace();
  ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  const columns = await ws.adapter.getColumns(ws.tableId);
  col = (name) => columns.find((c) => c.name === name)!.id;
  decide.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(async () => {
  vi.restoreAllMocks();
  await db.$disconnect();
});

describe('forward: an open receipt is decided by the model that knows the person', () => {
  it('the Rossmann receipt: earlier private drugstore answers and a statement make a confident "Privat", set and marked as automatic', async () => {
    await receipt({ Vendor: 'dm', Name: 'dm', Date: '2026-10-01', Zuordnung: 'Privat' });
    await receipt({ Vendor: 'Rossmann', Date: '2026-09-01', Zuordnung: 'Privat' });
    await db.classificationRule.create({ data: { authWorkspaceId: ws.workspaceId, type: 'freetext', matchValue: 'Drogerie ist privat.', zuordnung: 'Privat' } });
    const open = await receipt();
    decide.mockResolvedValueOnce(answer('Privat', 0.97));

    const result = await run();
    expect(result).toMatchObject({ candidates: 1, decided: 1, set: 1, suggested: 0, failed: 0, remaining: 0 });
    // The model saw the statement, the vendor's earlier answer and the similar receipts, never the receipt's own answer.
    const [seen, context, options] = decide.mock.calls[0];
    expect(seen).toMatchObject({ vendor: 'Rossmann', item: 'Schokolade', date: '2026-11-06' });
    expect(context.statements.map((s) => s.text)).toEqual(['Drogerie ist privat.']);
    expect(context.vendorHistory?.answers).toEqual([{ assignment: 'Privat', count: 1, latest: '2026-09-01' }]);
    expect(context.similar.length).toBeGreaterThan(0);
    expect(options).toEqual(expect.arrayContaining(['Geschäftlich', 'Privat', 'Universität']));
    expect(await assignmentOf(open)).toBe('Privat');
    expect(await decisionOf(open)).toMatchObject({ outcome: 'set', assignment: 'Privat', model: 'test/assignment-model', attempts: 0, answeredAt: null });
    // It is no longer asked, and the panel says why it was set.
    expect((await entryFor(open))?.reasons ?? []).not.toContain('assignment_missing');
    const notes = await assignmentNotes(db, ws.workspaceId, [{ rowId: open, assignment: 'Privat' }]);
    expect(notes.get(open)).toMatchObject({ kind: 'set', assignment: 'Privat', reason: 'Drogerie: bisher immer privat.' });
  });

  it('an unsure answer sets nothing: the review card asks, with the suggestion and its reason', async () => {
    const open = await receipt({ Vendor: 'Amazon', Item: 'USB-Kabel' });
    decide.mockResolvedValueOnce(answer('Geschäftlich', AUTO_ASSIGN_CONFIDENCE - 0.2, 'Technik bei Amazon, wie frühere Käufe geschäftlich.'));
    const result = await run();
    expect(result).toMatchObject({ decided: 1, set: 0, suggested: 1 });
    expect(await assignmentOf(open)).toBeNull();
    const entry = await entryFor(open);
    expect(entry?.reasons).toContain('assignment_missing');
    expect(entry?.assignmentSuggestion).toEqual({ assignment: 'Geschäftlich', confidence: AUTO_ASSIGN_CONFIDENCE - 0.2, reason: 'Technik bei Amazon, wie frühere Käufe geschäftlich.' });
  });

  it('a new workspace has no context: the model is asked from the document alone', async () => {
    await receipt();
    decide.mockResolvedValueOnce(answer(null, 0, 'Der Beleg zeigt nicht, wer ihn trägt.'));
    await run();
    const [, context] = decide.mock.calls[0];
    expect(context).toEqual({ statements: [], vendorHistory: null, similar: [], corrections: [] });
  });

  it('never decides a meal (the register judges it), a receipt a reading rule matches, or one a person answered', async () => {
    await receipt({ Category: 'Bewirtung', Vendor: 'Testlokal' });
    await db.classificationRule.create({ data: { authWorkspaceId: ws.workspaceId, type: 'vendor', matchValue: 'Hetzner', zuordnung: 'Geschäftlich' } });
    await receipt({ Vendor: 'Hetzner Online GmbH' });
    await receipt({ Zuordnung: 'Privat' });
    const result = await run();
    expect(result.candidates).toBe(0);
    expect(decide).not.toHaveBeenCalled();
  });

  it('the receipts a reading rule set are no evidence of the person', async () => {
    await db.classificationRule.create({ data: { authWorkspaceId: ws.workspaceId, type: 'vendor', matchValue: 'Rossmann', zuordnung: 'Privat' } });
    await receipt({ Zuordnung: 'Privat', Date: '2026-01-01' });
    await receipt({ Vendor: 'Rossmann Drogerie Markt', Zuordnung: 'Privat', Date: '2026-02-01' });
    const open = await receipt({ Vendor: 'Müller Drogerie', Item: 'Zahnpasta' });
    decide.mockResolvedValueOnce(answer(null, 0));
    await run({ only: [open] });
    expect(decide.mock.calls[0][1].similar).toEqual([]);
  });

  it('an answer the workspace has no option for is no answer: nothing is set', async () => {
    const open = await receipt();
    decide.mockResolvedValueOnce(answer(null, 0.99));
    expect(await run()).toMatchObject({ set: 0, suggested: 1 });
    expect(await assignmentOf(open)).toBeNull();
  });

  it('a person who answers while the model is asked wins: the write checks what the cell holds', async () => {
    const open = await receipt();
    decide.mockImplementationOnce(async () => {
      await ws.adapter.updateRow(open, { [col('Zuordnung')]: await optionId('Geschäftlich') });
      return answer('Privat', 0.99);
    });
    const result = await run();
    expect(result).toMatchObject({ set: 0, suggested: 1 });
    expect(await assignmentOf(open)).toBe('Geschäftlich');
    // The next run records the person's answer as an overruled suggestion and never asks again.
    expect(await run()).toMatchObject({ answersRecorded: 1, candidates: 0 });
    expect(await decisionOf(open)).toMatchObject({ answeredAs: 'Geschäftlich' });
  });

  it('a private receipt set automatically takes share 0, as every private receipt', async () => {
    const open = await receipt({ 'Business Share %': 100 });
    decide.mockResolvedValueOnce(answer('Privat', 0.99));
    await run();
    expect((await ws.adapter.getRow(open))!.cells[col('Business Share %')]).toBe(0);
  });
});

describe('backtrack: a person corrects, a re-read invalidates', () => {
  it('a person who changes an automatic answer is recorded as a correction, shown to the model later, and the receipt is never decided again', async () => {
    const wrong = await receipt({ Vendor: 'Apple', Item: 'iCloud+' });
    decide.mockResolvedValueOnce(answer('Privat', 0.98));
    await run();
    await personSets(wrong, 'Geschäftlich');
    expect(await decisionOf(wrong)).toMatchObject({ outcome: 'set', assignment: 'Privat', answeredAs: 'Geschäftlich' });

    // The corrected receipt is never asked again, also after its facts change.
    await ws.adapter.updateRow(wrong, { [col('Item')]: 'iCloud+ 2 TB' });
    const next = await receipt({ Vendor: 'Apple', Item: 'iCloud+', Date: '2026-12-06' });
    decide.mockResolvedValueOnce(answer('Geschäftlich', 0.95));
    const result = await run();
    expect(result.candidates).toBe(1);
    const [seen, context] = decide.mock.calls[1];
    expect(seen.date).toBe('2026-12-06');
    expect(context.corrections).toEqual([expect.objectContaining({ vendor: 'Apple', modelSaid: 'Privat', how: 'set', personSaid: 'Geschäftlich' })]);
    // The person's answer is evidence too, the model's own earlier one never.
    expect(context.vendorHistory?.answers).toEqual([{ assignment: 'Geschäftlich', count: 1, latest: '2026-11-06' }]);
    expect(await assignmentOf(next)).toBe('Geschäftlich');
    expect(await assignmentOf(wrong)).toBe('Geschäftlich');
  });

  it('a person who empties an automatic answer has answered too: it is asked, never decided again', async () => {
    const open = await receipt();
    decide.mockResolvedValueOnce(answer('Privat', 0.99));
    await run();
    await personSets(open, null);
    expect(await run()).toMatchObject({ candidates: 0 });
    expect(decide).toHaveBeenCalledTimes(1);
    expect((await entryFor(open))?.reasons).toContain('assignment_missing');
  });

  it('the automatic answer written again by a person is no correction', async () => {
    const open = await receipt();
    decide.mockResolvedValueOnce(answer('Privat', 0.99));
    await run();
    await personSets(open, 'Privat');
    expect(await decisionOf(open)).toMatchObject({ answeredAt: null });
  });

  it('a re-read (new text, new lines) makes the automatic answer count for nothing: decided again, and a confident new answer replaces it', async () => {
    const open = await receipt();
    decide.mockResolvedValueOnce(answer('Privat', 0.99));
    await run();
    await ws.adapter.updateRow(open, { [col('OCR Text')]: 'Rossmann\nDruckerpatrone 29,99', [col('Item')]: 'Druckerpatrone' });
    decide.mockResolvedValueOnce(answer('Geschäftlich', 0.96, 'Druckerpatrone: Bürobedarf, geschäftlich.'));
    expect(await run({ only: [open] })).toMatchObject({ candidates: 1, set: 1 });
    expect(await assignmentOf(open)).toBe('Geschäftlich');
    expect(await decisionOf(open)).toMatchObject({ outcome: 'set', assignment: 'Geschäftlich', answeredAt: null });
  });

  it('a changed vendor whose new answer is unsure takes the automatic answer back: the receipt is asked', async () => {
    const open = await receipt();
    decide.mockResolvedValueOnce(answer('Privat', 0.99));
    await run();
    await ws.adapter.updateRow(open, { [col('Vendor')]: 'MediaMarkt' });
    decide.mockResolvedValueOnce(answer('Geschäftlich', 0.6, 'Bei MediaMarkt entscheidet, was gekauft wurde.'));
    expect(await run()).toMatchObject({ cleared: 1, suggested: 1 });
    expect(await assignmentOf(open)).toBeNull();
    expect((await entryFor(open))?.assignmentSuggestion).toMatchObject({ assignment: 'Geschäftlich' });
  });

  it('new facts never reach a person\'s answer', async () => {
    const answered = await receipt({ Zuordnung: 'Universität' });
    await ws.adapter.updateRow(answered, { [col('Vendor')]: 'Anderer Anbieter' });
    expect(await run()).toMatchObject({ candidates: 0 });
    expect(await assignmentOf(answered)).toBe('Universität');
  });

  it('a vendor rule written after an automatic answer wins over it', async () => {
    const open = await receipt();
    decide.mockResolvedValueOnce(answer('Privat', 0.99));
    await run();
    await db.classificationRule.create({ data: { authWorkspaceId: ws.workspaceId, type: 'vendor', matchValue: 'Rossmann', zuordnung: 'Geschäftlich' } });
    await run();
    expect(await assignmentOf(open)).toBe('Geschäftlich');
    expect(await decisionOf(open)).toBeNull();
  });

  it('the reader\'s answer from the document is automatic, not the person\'s: it is keyed once and a change of it is a correction', async () => {
    const read = await receipt({ Vendor: 'Hetzner', Zuordnung: 'Geschäftlich' });
    await recordReaderAssignment(db, ctx, read, { assignment: 'Geschäftlich', model: 'test/reader' });
    expect(await decisionOf(read)).toMatchObject({ fingerprint: READER_PENDING, outcome: 'set' });
    const other = await receipt({ Vendor: 'Hetzner', Date: '2026-12-01' });
    decide.mockResolvedValueOnce(answer(null, 0));
    await run();
    // Keyed to the facts, never asked; and no evidence of the person for the other Hetzner receipt.
    expect((await decisionOf(read))!.fingerprint).not.toBe(READER_PENDING);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0][0].date).toBe('2026-12-01');
    expect(decide.mock.calls[0][1].vendorHistory).toBeNull();
    await personSets(read, 'Privat');
    expect(await decisionOf(read)).toMatchObject({ answeredAs: 'Privat' });
    void other;
  });
});

describe('resume: a failure sets nothing and is tried again', () => {
  it('a model failure is logged, sets nothing, counts an attempt, and the next run decides it', async () => {
    const open = await receipt();
    decide.mockRejectedValueOnce(new Error('timeout'));
    expect(await run()).toMatchObject({ failed: 1, set: 0 });
    expect(await assignmentOf(open)).toBeNull();
    expect(await decisionOf(open)).toMatchObject({ outcome: 'failed', attempts: 1 });
    expect(console.error).toHaveBeenCalledWith('[assignment] a receipt could not be decided:', 'Error');
    expect((await entryFor(open))?.reasons).toContain('assignment_missing');

    decide.mockResolvedValueOnce(answer('Privat', 0.99));
    expect(await run()).toMatchObject({ set: 1 });
    expect(await decisionOf(open)).toMatchObject({ outcome: 'set', attempts: 0 });
  });

  it('a receipt the model kept failing on is asked about no more until its facts change', async () => {
    const open = await receipt();
    decide.mockRejectedValue(new Error('boom'));
    for (let i = 0; i < MAX_ASSIGNMENT_ATTEMPTS; i++) await run();
    expect(await decisionOf(open)).toMatchObject({ attempts: MAX_ASSIGNMENT_ATTEMPTS });
    expect(await run()).toMatchObject({ candidates: 0 });
    expect(decide).toHaveBeenCalledTimes(MAX_ASSIGNMENT_ATTEMPTS);
  });

  it('a failure on outdated facts takes the automatic answer back, so the receipt is asked, not passed off as the person\'s', async () => {
    const open = await receipt();
    decide.mockResolvedValueOnce(answer('Privat', 0.99));
    await run();
    await ws.adapter.updateRow(open, { [col('Vendor')]: 'Müller' });
    decide.mockRejectedValueOnce(new Error('timeout'));
    expect(await run()).toMatchObject({ failed: 1, cleared: 1 });
    expect(await assignmentOf(open)).toBeNull();
    decide.mockResolvedValueOnce(answer('Privat', 0.99));
    expect(await run()).toMatchObject({ set: 1 });
  });

  it('without a model nothing is counted against a receipt, and a bounded run leaves the rest', async () => {
    await receipt();
    await receipt({ Vendor: 'dm' });
    decide.mockRejectedValue(new ClassifierUnavailableError());
    expect(await run()).toMatchObject({ unavailable: true, failed: 0, remaining: 2 });
    expect(await db.receiptAssignmentDecision.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);

    decide.mockReset();
    decide.mockResolvedValue(answer('Privat', 0.99));
    expect(await run({ limit: 1 })).toMatchObject({ decided: 1, remaining: 1 });
    expect(await run({ limit: 1 })).toMatchObject({ decided: 1, remaining: 0 });
  });

  it('the daily run takes only the receipts whose decision failed', async () => {
    // The oldest is decided first.
    const failed = await receipt({ Date: '2026-11-01' });
    await receipt({ Vendor: 'dm', Date: '2026-11-02' });
    decide.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(answer(null, 0));
    await run();
    decide.mockReset();
    decide.mockResolvedValue(answer('Privat', 0.99));
    const result = await run({ failedOnly: true });
    expect(result).toMatchObject({ candidates: 1, set: 1 });
    expect(await assignmentOf(failed)).toBe('Privat');
  });
});

describe('re-entry: running the pass again changes nothing already decided', () => {
  it('a second run over the same receipts asks nothing and writes nothing', async () => {
    const set = await receipt();
    const suggested = await receipt({ Vendor: 'Amazon' });
    decide.mockImplementation(async (r) => (r.vendor === 'Rossmann' ? answer('Privat', 0.99) : answer('Geschäftlich', 0.5)));
    await run();
    const before = await db.receiptAssignmentDecision.findMany({ where: { authWorkspaceId: ws.workspaceId }, orderBy: { rowId: 'asc' } });
    decide.mockClear();
    expect(await run()).toMatchObject({ candidates: 0, decided: 0, answersRecorded: 0 });
    expect(decide).not.toHaveBeenCalled();
    expect(await db.receiptAssignmentDecision.findMany({ where: { authWorkspaceId: ws.workspaceId }, orderBy: { rowId: 'asc' } })).toEqual(before);
    expect(await assignmentOf(set)).toBe('Privat');
    expect(await assignmentOf(suggested)).toBeNull();
  });
});

describe('Bewirtung: the meal register keeps its receipts', () => {
  it('marking a meal as a business meal with its occasion sets the assignment to business', async () => {
    const meal = await ws.addReceipt({ Name: 'Testlokal', Vendor: 'Testlokal', Gross: 80, Date: '2026-10-09', Category: 'Bewirtung', Currency: 'EUR', 'FX Rate': 1, Zuordnung: 'Privat' });
    await saveMealDetails(db, ctx, meal, { mealType: 'business_meal_external', occasion: 'Projektbesprechung Website-Relaunch', place: 'Testlokal, Berlin', host: 'Marlin', tip: null, consumption: 'dine_in', taxLines: [], guestContactIds: [], date: null, gross: null });
    expect(await assignmentOf(meal)).toBe('Geschäftlich');
  });

  it("the reader's answer on a meal is keyed too, and the meal is still never decided", async () => {
    const meal = await ws.addReceipt({ Name: 'Testlokal', Vendor: 'Testlokal', Gross: 80, Date: '2026-10-09', Category: 'Bewirtung', Currency: 'EUR', 'FX Rate': 1, Zuordnung: 'Geschäftlich' });
    await recordReaderAssignment(db, ctx, meal, { assignment: 'Geschäftlich', model: 'test/reader' });
    await run();
    expect((await decisionOf(meal))!.fingerprint).not.toBe(READER_PENDING);
    expect(decide).not.toHaveBeenCalled();
  });

  it('an unmarked meal is never decided, so no automatic "Privat" takes it out of the list', async () => {
    const meal = await ws.addReceipt({ Name: 'Testlokal', Vendor: 'Testlokal', Gross: 80, Date: '2026-10-09', Category: 'Bewirtung', Currency: 'EUR', 'FX Rate': 1 });
    await run();
    expect(decide).not.toHaveBeenCalled();
    expect(await assignmentOf(meal)).toBeNull();
  });
});

describe('a deleted receipt takes its decision with it', () => {
  it('no decision is left behind for a row that is gone', async () => {
    const open = await receipt();
    decide.mockResolvedValueOnce(answer('Privat', 0.99));
    await run();
    expect(await decisionOf(open)).not.toBeNull();
    await deleteReceiptRows(db, ctx, [open], { deleteStoredFile: async () => {} });
    expect(await decisionOf(open)).toBeNull();
  });
});

describe('review findings of #246: races, the share, the time budget', () => {
  it('a person who empties the cell while the model is asked keeps their answer: the run records nothing over it', async () => {
    const open = await receipt();
    decide.mockResolvedValueOnce(answer('Privat', 0.99));
    await run();
    await ws.adapter.updateRow(open, { [col('Vendor')]: 'Müller' });
    decide.mockImplementationOnce(async () => {
      await personSets(open, null);
      return answer('Geschäftlich', 0.99);
    });
    expect(await run()).toMatchObject({ superseded: 1, set: 0 });
    expect(await assignmentOf(open)).toBeNull();
    expect(await decisionOf(open)).toMatchObject({ answeredAt: expect.any(Date), answeredAs: null });
    // Never decided again.
    expect(await run()).toMatchObject({ candidates: 0 });
  });

  it('two runs on the same receipt: the second answer is dropped, so the model\'s value never passes for the person\'s', async () => {
    const open = await receipt();
    decide.mockImplementationOnce(async (r, c, o) => {
      // Another run decides the same receipt while this one waits for its answer.
      const inner = vi.fn(async () => answer('Privat', 0.99));
      await decideAssignments(db, ctx, { decide: inner }, { limit: 1 });
      void r; void c; void o;
      return answer('Geschäftlich', 0.5);
    });
    const result = await run();
    expect(result.superseded).toBe(1);
    expect(await assignmentOf(open)).toBe('Privat');
    expect(await decisionOf(open)).toMatchObject({ outcome: 'set', assignment: 'Privat', answeredAt: null });
    // The next run sees the automatic answer as automatic, not as a person's.
    expect(await run()).toMatchObject({ answersRecorded: 0, candidates: 0 });
  });

  it('replacing its own outdated "Privat" with a business answer brings the share back', async () => {
    const open = await receipt({ 'Business Share %': 60 });
    decide.mockResolvedValueOnce(answer('Privat', 0.99));
    await run();
    expect((await ws.adapter.getRow(open))!.cells[col('Business Share %')]).toBe(0);
    await ws.adapter.updateRow(open, { [col('Item')]: 'Druckerpatrone' });
    decide.mockResolvedValueOnce(answer('Geschäftlich', 0.99));
    await run();
    expect(await assignmentOf(open)).toBe('Geschäftlich');
    expect((await ws.adapter.getRow(open))!.cells[col('Business Share %')]).toBe(60);
  });

  it('a rule taking over an automatic answer brings the share in step: "Privat" to business restores it, business to "Privat" makes it 0', async () => {
    const priv = await receipt({ 'Business Share %': 100 });
    const biz = await receipt({ Vendor: 'Hetzner', 'Business Share %': 100 });
    decide.mockImplementation(async (r) => answer(r.vendor === 'Hetzner' ? 'Geschäftlich' : 'Privat', 0.99));
    await run();
    await db.classificationRule.create({ data: { authWorkspaceId: ws.workspaceId, type: 'vendor', matchValue: 'Rossmann', zuordnung: 'Geschäftlich' } });
    await db.classificationRule.create({ data: { authWorkspaceId: ws.workspaceId, type: 'vendor', matchValue: 'Hetzner', zuordnung: 'Privat' } });
    await run();
    expect(await assignmentOf(priv)).toBe('Geschäftlich');
    expect((await ws.adapter.getRow(priv))!.cells[col('Business Share %')]).toBe(100);
    expect(await assignmentOf(biz)).toBe('Privat');
    expect((await ws.adapter.getRow(biz))!.cells[col('Business Share %')]).toBe(0);
  });

  it('no model call starts after the deadline: the rest is left for the next request', async () => {
    await receipt({ Date: '2026-11-01' });
    await receipt({ Vendor: 'dm', Date: '2026-11-02' });
    let t = 1_000;
    decide.mockImplementation(async () => {
      t += 10_000;
      return answer(null, 0);
    });
    const result = await decideAssignments(db, ctx, deps, { limit: 10, deadline: 5_000, now: () => new Date(t) });
    expect(result).toMatchObject({ decided: 1, remaining: 1 });
  });
});

describe('second review of #246: a claim in flight, and one left behind', () => {
  const claimOf = (rowId: string, decidedAt: Date) =>
    db.receiptAssignmentDecision.create({ data: { rowId, authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId, fingerprint: 'f', outcome: CLAIMING, assignment: 'Privat', confidence: 0.99, reason: 'r', model: 'm', decidedAt } });

  it('a cell write that throws after the claim leaves the receipt asked, and the next run records no answer', async () => {
    const open = await receipt();
    const original = db.$executeRawUnsafe.bind(db);
    const spy = vi.spyOn(db, '$executeRawUnsafe').mockImplementationOnce((async (query: string, ...values: unknown[]) => {
      if (query.startsWith('UPDATE')) throw new Error('connection reset');
      return original(query, ...values);
    }) as typeof db.$executeRawUnsafe);
    decide.mockResolvedValueOnce(answer('Privat', 0.99));
    expect(await run()).toMatchObject({ failed: 1, set: 0 });
    spy.mockRestore();
    expect(await assignmentOf(open)).toBeNull();
    expect(await decisionOf(open)).toMatchObject({ outcome: 'failed', attempts: 1, answeredAt: null });
    decide.mockResolvedValueOnce(answer('Privat', 0.99));
    expect(await run()).toMatchObject({ answersRecorded: 0, set: 1 });
    expect(await decisionOf(open)).toMatchObject({ outcome: 'set', answeredAt: null });
  });

  it('another run\'s claim in flight is left alone: not an answer, not decided, its cell no evidence', async () => {
    const claimed = await receipt();
    await claimOf(claimed, new Date());
    // The claiming run has written the cell but not yet marked the claim "set".
    await ws.adapter.updateRow(claimed, { [col('Zuordnung')]: await optionId('Privat') });
    const other = await receipt({ Date: '2026-12-01' });
    decide.mockResolvedValueOnce(answer(null, 0));
    const result = await run();
    expect(result).toMatchObject({ answersRecorded: 0, candidates: 1 });
    expect(decide.mock.calls[0][0].date).toBe('2026-12-01');
    expect(decide.mock.calls[0][1].vendorHistory).toBeNull();
    expect(await decisionOf(claimed)).toMatchObject({ outcome: CLAIMING, answeredAt: null });
    void other;
  });

  it('a claim left behind is settled from the cell: written is set, not written is asked again', async () => {
    const old = new Date(Date.now() - CLAIM_TTL_MS - 60_000);
    const written = await receipt();
    await claimOf(written, old);
    await ws.adapter.updateRow(written, { [col('Zuordnung')]: await optionId('Privat') });
    const notWritten = await receipt({ Vendor: 'dm' });
    await claimOf(notWritten, old);
    // The test's claims rest on a made-up fingerprint, so the written one is decided again too: as automatic, never as an answer.
    decide.mockResolvedValue(answer('Privat', 0.99));
    const result = await run();
    expect(result.answersRecorded).toBe(0);
    expect(await decisionOf(written)).toMatchObject({ outcome: 'set', answeredAt: null });
    expect(await assignmentOf(written)).toBe('Privat');
    expect(await decisionOf(notWritten)).toMatchObject({ outcome: 'set', assignment: 'Privat' });
    expect(await assignmentOf(notWritten)).toBe('Privat');
  });

  it('a run that read before another run set its answer never takes that answer for a person\'s', async () => {
    const open = await receipt();
    const original = db.receiptAssignmentDecision.findMany.bind(db.receiptAssignmentDecision);
    let paused = false;
    const spy = vi.spyOn(db.receiptAssignmentDecision, 'findMany').mockImplementation((async (args: Parameters<typeof original>[0]) => {
      const read = await original(args);
      if (!paused) {
        paused = true;
        // Run B has read the decisions; run A claims, writes and finalizes before B reads the cells.
        await decideAssignments(db, ctx, { decide: async () => answer('Privat', 0.99) }, { limit: 1 });
      }
      return read;
    }) as unknown as typeof db.receiptAssignmentDecision.findMany);
    decide.mockResolvedValue(answer('Geschäftlich', 0.99));
    const b = await run();
    spy.mockRestore();
    expect(b.answersRecorded).toBe(0);
    expect(await assignmentOf(open)).toBe('Privat');
    expect(await decisionOf(open)).toMatchObject({ outcome: 'set', assignment: 'Privat', answeredAt: null });
    // Later runs see the model's own answer as automatic.
    decide.mockClear();
    expect(await run()).toMatchObject({ answersRecorded: 0, candidates: 0 });
  });
});
