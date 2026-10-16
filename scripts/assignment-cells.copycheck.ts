import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { financeFigures, overviewAttributed, summary } from './finance-figures';
import { settled, syncAllWorkspaces } from './sync-assignment-cells';

/**
 * The equality check of the assignment-cell migration, on a LOCAL copy of
 * production (never production itself; test/copy-setup.ts refuses any other
 * host). Restore a backup into a throwaway Postgres, then:
 *
 *   COPY_DATABASE_URL=postgresql://...@127.0.0.1:<port>/<db> pnpm check:copy
 *
 * It computes every finance figure of every workspace and year (totals, each
 * statement line, each item's counted parts and open checks), runs the
 * migration on the copy, computes them again and requires them to be equal.
 * A second run must plan nothing. The three totals per year are written to
 * COPY_REPORT (default /tmp/assignment-cells-copycheck.json) for the record,
 * together with the overview page's "attributed" euros before and after, which
 * the migration moves on purpose (see `overviewAttributed`).
 */
describe('assignment-cell migration on a copy of production', () => {
  it('changes no figure of any workspace and year, and is idempotent', async () => {
    const db = new PrismaClient({ datasourceUrl: process.env.COPY_DATABASE_URL });
    try {
      const before = await financeFigures(db);
      const overviewBefore = await overviewAttributed();
      const applied = await syncAllWorkspaces(db, true);
      const after = await financeFigures(db);
      const overviewAfter = await overviewAttributed();
      const again = await syncAllWorkspaces(db, false);
      writeFileSync(
        process.env.COPY_REPORT ?? '/tmp/assignment-cells-copycheck.json',
        JSON.stringify({ written: applied.filter((p) => !settled(p)), before: summary(before), after: summary(after), overviewBefore, overviewAfter }, null, 1),
      );
      expect(after).toEqual(before);
      expect(again.every(settled)).toBe(true);
    } finally {
      await db.$disconnect();
    }
  });
});
