// Step 2 of the assignment replay (scripts/assignment-replay.ts, plan
// docs/plans/2026-11-07-learned-assignment.md, decision 6): sends each prepared
// prompt to the model through OpenRouter and appends one answer per line.
//
//   node scripts/assignment-replay-call.mjs <prompts.jsonl> <results.jsonl> [model] [concurrency]
//
// Needs OPENROUTER_API_KEY in the environment (run it through the secrets
// proxy, never with the key on a command line). Resumable: prompts that
// already have an answer in the results file are skipped, so a run that was
// cut off continues where it stopped. A failed call is written with its error
// class and tried again on the next run. Prints counts only, never a prompt, an
// answer or a reason. The parsing is the app's (parseAssignmentResponse),
// repeated here so this file runs with plain node.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const [promptsPath, resultsPath, model = 'anthropic/claude-sonnet-5.5', concurrencyArg = '8'] = process.argv.slice(2);
if (!promptsPath || !resultsPath) {
  console.error('usage: assignment-replay-call.mjs <prompts.jsonl> <results.jsonl> [model] [concurrency]');
  process.exit(2);
}
const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error('OPENROUTER_API_KEY is not set');
  process.exit(1);
}
const OPTIONS = ['Universität', 'Geschäftlich', 'Privat'];
const readJsonl = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);

const prompts = readJsonl(promptsPath);
const done = new Set(readJsonl(resultsPath).filter((r) => !r.error).map((r) => r.id));
const todo = prompts.filter((p) => !done.has(p.id));
const deadline = Date.now() + Number(process.env.REPLAY_BUDGET_MS ?? 240_000);

function parse(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('unusable');
  const parsed = JSON.parse(text.slice(first, last + 1));
  const raw = parsed?.assignment;
  const assignment = typeof raw === 'string' ? (OPTIONS.find((o) => o.toLocaleLowerCase('de-DE') === raw.trim().toLocaleLowerCase('de-DE')) ?? null) : null;
  const confidence = typeof parsed?.confidence === 'number' && Number.isFinite(parsed.confidence) ? Math.min(1, Math.max(0, parsed.confidence)) : 0;
  return { assignment, confidence: assignment ? confidence : 0 };
}

let cost = 0;
let ok = 0;
let failed = 0;
async function one(p) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'X-Title': 'Receipt OCR App (assignment replay)' },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        reasoning: { effort: 'low' },
        usage: { include: true },
        messages: [
          { role: 'system', content: p.system },
          { role: 'user', content: p.user },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const body = await res.json();
    if (typeof body?.usage?.cost === 'number') cost += body.usage.cost;
    const answer = parse(body?.choices?.[0]?.message?.content ?? '');
    appendFileSync(resultsPath, JSON.stringify({ id: p.id, ...answer }) + '\n');
    ok++;
  } catch (err) {
    failed++;
    appendFileSync(resultsPath, JSON.stringify({ id: p.id, assignment: null, confidence: 0, error: err instanceof Error ? err.message.slice(0, 40) : 'error' }) + '\n');
  }
}

const queue = [...todo];
const workers = Array.from({ length: Math.max(1, Number(concurrencyArg)) }, async () => {
  while (queue.length && Date.now() < deadline) await one(queue.shift());
});
await Promise.all(workers);
console.log(JSON.stringify({ model, prompts: prompts.length, alreadyDone: done.size, answeredNow: ok, failedNow: failed, left: queue.length, costUsd: Number(cost.toFixed(4)) }));
