import { defineConfig } from 'vitest/config';

/**
 * The stage of `pnpm verify` that runs before anything writes to a database:
 * it refuses every database URL of the run that is not a local throwaway
 * database (test/verify-databases.guardcheck.ts, with the rules of test/db-guard.ts).
 */
export default defineConfig({
  test: {
    include: ['test/**/*.guardcheck.ts'],
  },
});
