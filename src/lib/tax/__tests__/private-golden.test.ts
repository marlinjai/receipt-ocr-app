import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeYear } from '../compute';
import { eurosToCents } from '../money';
import { rulesForYear } from '../rules';
import type { FormLineKey } from '../rules/types';
import type { LedgerItem } from '../types';

/**
 * The owner's real worked year, read from his machine and never committed
 * (this repository is public). Point TAX_GOLDEN_DIR at the folder holding
 * `entwurf-ausgaben-2025.csv` (columns: form, line, item, paid_gross_eur,
 * share, claimed_eur, basis, open_check) and run `pnpm test`.
 *
 * The file is still being regenerated while that return is prepared, so the
 * test pins no fixed figure: it requires that every row's claimed amount is
 * what the tax module computes from the paid amount and the share, and that
 * the per-line sums agree. Without the variable the test is skipped, and says
 * so, which is always the case in continuous integration.
 */
const dir = process.env.TAX_GOLDEN_DIR;
const file = dir ? path.join(dir, 'entwurf-ausgaben-2025.csv') : null;
const available = file !== null && existsSync(file);

/** Minimal CSV reader for quoted fields with commas; the file has no line breaks inside fields. */
function parseCsv(text: string): Record<string, string>[] {
  const rows = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      const cells: string[] = [];
      let cell = '';
      let quoted = false;
      for (let i = 0; i < l.length; i++) {
        const ch = l[i];
        if (quoted) {
          if (ch === '"' && l[i + 1] === '"') {
            cell += '"';
            i++;
          } else if (ch === '"') quoted = false;
          else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') {
          cells.push(cell);
          cell = '';
        } else cell += ch;
      }
      cells.push(cell);
      return cells;
    });
  const [header, ...body] = rows;
  return body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
}

describe.skipIf(!available)('private golden year 2025 (local only)', () => {
  it('reproduces every claimed amount and every line sum of the worked return', () => {
    const rows = parseCsv(readFileSync(file as string, 'utf-8'));
    expect(rows.length).toBeGreaterThan(0);

    // The worked file labels lines its own way; each label gets one line key
    // here so that sums per label can be compared. Which key is irrelevant to
    // what this test checks (shares, rounding, sums).
    const euerKeys = rulesForYear(2025).rules.formLines.filter((l) => l.form === 'euer' && l.key !== 'euer.meals').map((l) => l.key);
    const keyByLabel = new Map<string, FormLineKey>();
    const expectedByKey = new Map<FormLineKey, number>();
    const items: LedgerItem[] = [];
    const mismatches: string[] = [];

    rows.forEach((row, index) => {
      const business = row.form === 'EUER';
      const label = `${row.form}|${row.line}`;
      if (!keyByLabel.has(label)) {
        const key = business ? euerKeys[[...keyByLabel.keys()].filter((k) => k.startsWith('EUER|')).length] : 'employment.study_costs';
        if (!key) throw new Error('more line labels in the worked file than line keys to map them to');
        keyByLabel.set(label, key);
      }
      const key = keyByLabel.get(label) as FormLineKey;
      const claimed = eurosToCents(Number(row.claimed_eur));
      expectedByKey.set(key, (expectedByKey.get(key) ?? 0) + claimed);
      items.push({
        id: String(index),
        label: `row ${index + 2}`,
        vendor: null,
        date: '2025-06-30',
        dateBasis: 'document',
        amountCents: eurosToCents(Number(row.paid_gross_eur)),
        amountBasis: 'payment',
        formLineKey: business ? key : null,
        employmentLineKey: business ? null : key,
        allocations: [{ purpose: business ? 'business' : 'study', shareBp: Math.round(Number(row.share) * 10000) }],
        smallBusiness: true,
        meal: null,
      });
    });

    const result = computeYear({ year: 2025, items }, rulesForYear(2025));
    expect(result.blockedItems).toBe(0);

    rows.forEach((row, index) => {
      const computed = result.items[index].parts.reduce((s, p) => s + p.cents, 0);
      const claimed = eurosToCents(Number(row.claimed_eur));
      // Row numbers only: no item text or amount leaves the machine through a test log.
      if (computed !== claimed) mismatches.push(`row ${index + 2}: off by ${computed - claimed} cents`);
    });
    expect(mismatches).toEqual([]);

    for (const [key, expected] of expectedByKey) {
      expect(result.lines.find((l) => l.key === key)?.cents ?? 0).toBe(expected);
    }
  });
});

describe.skipIf(available)('private golden year 2025', () => {
  it.skip('skipped: TAX_GOLDEN_DIR is not set, the real worked year is only checked on the owner\'s machine', () => {});
});
