/**
 * Who bears a receipt's cost, asked of a model that knows the person (plan
 * docs/plans/2026-11-07-learned-assignment.md): the prompt, the receipt as the
 * model sees it, and the parsing of its answer.
 *
 * Pure, with no import of the app's server code: the app and the replay
 * (scripts/assignment-replay.ts, run before the feature is switched on) build
 * the same prompt from the same facts, so what was measured is what runs.
 */

/** One printed position of a receipt, as far as the assignment needs it. */
export interface AssignmentLine {
  text: string;
  /** In the receipt's currency, negative for money off. */
  grossCents: number;
  /** The kind of purchase as read (src/lib/line-items/kinds.ts). */
  kind: string;
}

/** The receipt being decided, reduced to what decides who bears it. */
export interface AssignmentReceipt {
  vendor: string | null;
  /** ISO day, or null. */
  date: string | null;
  category: string | null;
  /** What was bought, in a few words (the Item column). */
  item: string | null;
  gross: number | null;
  currency: string;
  lines: readonly AssignmentLine[];
  /** The recognized text, as stored. */
  text: string;
}

/** A statement the person made about themselves (a freetext rule). */
export interface Statement {
  id: string;
  text: string;
  /** The assignment it names, if exactly one. */
  assignment: string | null;
  /** Set for a statement about one vendor ("Was ist das?"): it is given only for that vendor's receipts. */
  subject?: string | null;
}

/** An earlier receipt with a person's answer. */
export interface PastAnswer {
  rowId: string;
  vendor: string;
  date: string | null;
  category: string | null;
  item: string | null;
  lines: readonly string[];
  assignment: string;
}

/** How the person answered one vendor before. */
export interface VendorHistory {
  vendor: string;
  answers: Array<{ assignment: string; count: number; latest: string | null }>;
}

/** A receipt where the person changed or overruled the model's answer: the strongest signal. */
export interface Correction {
  vendor: string;
  date: string | null;
  category: string | null;
  item: string | null;
  /** What the model said. */
  modelSaid: string | null;
  /** Whether the model's answer had been set ('set') or only suggested ('suggested'). */
  how: 'set' | 'suggested';
  /** What the person answered. */
  personSaid: string;
}

/** Everything the model is told about the person. None of it is a fixed list in code. */
export interface AssignmentContext {
  statements: readonly Statement[];
  vendorHistory: VendorHistory | null;
  similar: readonly PastAnswer[];
  corrections: readonly Correction[];
}

export interface AssignmentAnswerCore {
  /** One of the options, or null where the model would not answer. */
  assignment: string | null;
  /** 0 to 1, as the model rates its own answer. */
  confidence: number;
  /** One sentence in German, shown to the person as it is. */
  reason: string;
}

export class UnusableAssignmentAnswer extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnusableAssignmentAnswer';
  }
}

/** The recognized text the model gets: the head (vendor, buyer, what was bought) and the end. */
const TEXT_LIMIT = 3000;
const TEXT_TAIL = 800;
/** Positions shown per receipt: enough to tell chocolate from a cable. */
const LINE_LIMIT = 15;

export function assignmentText(fullText: string): string {
  const text = fullText.trim();
  if (text.length <= TEXT_LIMIT) return text;
  return `${text.slice(0, TEXT_LIMIT - TEXT_TAIL)}\n[...]\n${text.slice(-TEXT_TAIL)}`;
}

/** The meaning of the options the app ships. A workspace with other options gets them without a gloss. */
const OPTION_MEANING: Record<string, string> = {
  Geschäftlich: 'the business bears it (an operating expense of the person\'s company or self-employment)',
  Universität: 'a cost of the person\'s studies (fees, books, a course, travel to the university)',
  Privat: 'the person bears it privately; it stays out of the books',
};

export function assignmentPrompt(options: readonly string[]): string {
  const list = options.map((o) => `- "${o}"${OPTION_MEANING[o] ? `: ${OPTION_MEANING[o]}` : ''}`).join('\n');
  return `You decide who bears the cost of one receipt for one person, who keeps business, study and private receipts in one app. The options:
${list}

You are given the receipt (vendor, day, category, what was bought, its positions, the recognized text) and what the app has learned about this person:
1. STATEMENTS the person made about themselves. They are true and they win over everything else. A dated statement applies by the receipt's day ("studies ended in May 2026" means no study cost on a receipt from June 2026 on, but a receipt from March 2026 can still be one).
2. CORRECTIONS: receipts where the app answered and the person answered differently. Never repeat such a mistake on a receipt of the same kind.
3. HOW THE PERSON ANSWERED THIS VENDOR before, with counts and the latest day, and EARLIER SIMILAR RECEIPTS with their positions and the person's answer.

How to decide:
- A vendor the person always answered the same way, for the same kind of purchase, is strong evidence. A vendor that sells many kinds of things (a marketplace, an electronics store, a platform) is decided by what was bought, not by the vendor.
- The document itself counts too: an invoice addressed to a company or carrying the buyer's VAT identification number is business; one addressed to a university or naming an enrolment is study. A personal name or a home address says nothing: a self-employed person is invoiced under their own name.
- A meal in a restaurant follows the statements; without one that settles it, do not guess.
- Where nothing above settles it, answer null. A wrong "Privat" silently leaves a business cost out of the books; a wrong business answer books a private cost. Both are worse than asking the person.

"confidence" is how sure you are, from 0 to 1: 0.95 or more only where a statement or a consistent history of the same vendor and the same kind of purchase settles it; around 0.7 where it is likely but the evidence is thin; below 0.5 where you are guessing (then rather answer null). "reason": one sentence in German naming what decides it, for the person to read (for example "Drogerie: Rossmann und dm hast du bisher immer privat zugeordnet." or "Kabel und Speicher bei Amazon, wie deine früheren Technikkäufe geschäftlich.").

Respond with ONLY a JSON object (no markdown, no explanation):
{ "assignment": ${options.map((o) => `"${o}"`).join(' | ')} | null, "confidence": 0.0, "reason": "..." }`;
}

const money = (cents: number) => (cents / 100).toFixed(2);

function receiptLines(lines: readonly AssignmentLine[]): string {
  if (lines.length === 0) return '(none read)';
  const shown = lines.slice(0, LINE_LIMIT).map((l) => `  - ${l.text.replace(/\s+/g, ' ').trim()} (${money(l.grossCents)}, ${l.kind})`);
  if (lines.length > LINE_LIMIT) shown.push(`  - ... and ${lines.length - LINE_LIMIT} more`);
  return shown.join('\n');
}

const orUnknown = (v: string | null | undefined) => (v && v.trim() ? v.trim() : 'unknown');

function pastLine(p: PastAnswer): string {
  const bought = [p.item, ...p.lines.slice(0, 4)].filter(Boolean).join('; ');
  return `- ${p.date ?? 'no day'}, ${orUnknown(p.vendor)}, ${orUnknown(p.category)}${bought ? `, bought: ${bought}` : ''}: answered "${p.assignment}"`;
}

/** The user message: the receipt, then what the app knows about the person. */
export function assignmentUserText(receipt: AssignmentReceipt, context: AssignmentContext): string {
  const parts: string[] = [];
  parts.push('STATEMENTS of the person:');
  parts.push(context.statements.length ? context.statements.map((s) => `- ${s.text}${s.assignment ? ` (names: ${s.assignment})` : ''}`).join('\n') : '(none yet)');
  parts.push('');
  parts.push('CORRECTIONS (the app answered, the person answered differently):');
  parts.push(
    context.corrections.length
      ? context.corrections
          .map((c) => `- ${c.date ?? 'no day'}, ${orUnknown(c.vendor)}, ${orUnknown(c.category)}${c.item ? `, bought: ${c.item}` : ''}: the app ${c.how === 'set' ? 'set' : 'suggested'} ${c.modelSaid ? `"${c.modelSaid}"` : 'nothing'}, the person answered "${c.personSaid}"`)
          .join('\n')
      : '(none yet)',
  );
  parts.push('');
  parts.push('HOW THE PERSON ANSWERED THIS VENDOR before:');
  parts.push(
    context.vendorHistory && context.vendorHistory.answers.length
      ? context.vendorHistory.answers.map((a) => `- "${a.assignment}": ${a.count} time${a.count === 1 ? '' : 's'}, latest ${a.latest ?? 'without a day'}`).join('\n')
      : '(never answered for this vendor)',
  );
  parts.push('');
  parts.push('EARLIER SIMILAR RECEIPTS with the person\'s answer:');
  parts.push(context.similar.length ? context.similar.map(pastLine).join('\n') : '(none)');
  parts.push('');
  parts.push('THE RECEIPT to decide:');
  parts.push(`Vendor: ${orUnknown(receipt.vendor)}`);
  parts.push(`Day: ${receipt.date ?? 'unknown'}`);
  parts.push(`Category: ${orUnknown(receipt.category)}`);
  parts.push(`What was bought: ${orUnknown(receipt.item)}`);
  parts.push(`Total: ${receipt.gross ?? 'unknown'} ${receipt.currency}`);
  parts.push(`Positions:\n${receiptLines(receipt.lines)}`);
  parts.push(`Recognized text:\n${receipt.text.trim() ? assignmentText(receipt.text) : '(none)'}`);
  return parts.join('\n');
}

/** Parse the model's answer. Anything malformed throws: it is no answer, and nothing is set on it. */
export function parseAssignmentResponse(text: string, options: readonly string[]): AssignmentAnswerCore {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) throw new UnusableAssignmentAnswer('The answer was not the expected object.');
  let parsed: { assignment?: unknown; confidence?: unknown; reason?: unknown } | null;
  try {
    parsed = JSON.parse(text.slice(first, last + 1));
  } catch {
    throw new UnusableAssignmentAnswer('The answer was not the expected object.');
  }
  if (!parsed || typeof parsed !== 'object') throw new UnusableAssignmentAnswer('The answer was not the expected object.');
  const raw = parsed.assignment;
  // An option the workspace does not have is no answer for it: null, never a value the cell cannot hold.
  const assignment = typeof raw === 'string' ? (options.find((o) => o.toLocaleLowerCase('de-DE') === raw.trim().toLocaleLowerCase('de-DE')) ?? null) : null;
  const confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence) ? Math.min(1, Math.max(0, parsed.confidence)) : 0;
  const reason = typeof parsed.reason === 'string' ? parsed.reason.replace(/\s+/g, ' ').trim().slice(0, 400) : '';
  return { assignment, confidence: assignment ? confidence : 0, reason };
}
