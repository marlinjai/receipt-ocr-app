import { createHash } from 'node:crypto';
import type { AssignmentReceipt } from './prompt';

/**
 * The facts an assignment decision rests on, as one key (plan
 * docs/plans/2026-11-07-learned-assignment.md, "Paths"): the vendor, the day,
 * the category, what was bought, the lines and the recognized text. A new
 * reading ("Seite neu lesen"), a corrected vendor or new lines change it, and
 * the decision then counts for nothing. The person's context is deliberately
 * not part of it: a new answer elsewhere must not undo every decision taken.
 */
export function assignmentFingerprint(r: Pick<AssignmentReceipt, 'vendor' | 'date' | 'category' | 'item' | 'lines' | 'text'>): string {
  const norm = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('de-DE');
  const facts = [
    norm(r.vendor),
    r.date ?? '',
    norm(r.category),
    norm(r.item),
    r.lines.map((l) => `${norm(l.text)}=${l.grossCents}:${l.kind}`).join('|'),
    createHash('sha256').update(r.text.replace(/\s+/g, ' ').trim()).digest('hex'),
  ];
  return createHash('sha256').update(facts.join('\n')).digest('hex').slice(0, 32);
}
