import { defineConfig } from 'vitest/config';
import path from 'path';
import { DB_TEST_WORKERS } from './test/db-workers';

/**
 * Database-backed tests (`pnpm test:db`). They run the real Prisma queries and
 * the real data-table adapter against a Postgres that has the migrations
 * applied, and they REQUIRE `TEST_DATABASE_URL`: the setup file throws when it
 * is missing, so this suite can never "pass" by silently skipping.
 *
 * Point it at throwaway databases only: local, with names ending in `_test`
 * (test/db-guard.ts refuses anything else). The global setup empties both
 * databases and copies them once per worker (test/db-reset.ts, test/db-workers.ts);
 * every file then runs in its worker's copy and empties it first (test/db-setup.ts).
 * So the files run side by side, a file meets only what it creates, and the suite
 * passes in any order (`pnpm test:db --sequence.shuffle`).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'next/server': path.resolve(__dirname, 'test/stubs/next-server.ts'),
      'server-only': path.resolve(__dirname, 'test/stubs/server-only.ts'),
    },
  },
  test: {
    include: ['src/**/*.dbtest.ts'],
    server: { deps: { inline: ['@marlinjai/auth-brain-nextjs'] } },
    globalSetup: ['test/db-reset.ts'],
    setupFiles: ['test/db-setup.ts'],
    pool: 'forks',
    // One database copy per worker: the number is bounded by Postgres connections (see test/db-workers.ts).
    maxWorkers: DB_TEST_WORKERS,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
