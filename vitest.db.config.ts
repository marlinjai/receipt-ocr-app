import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Database-backed tests (`pnpm test:db`). They run the real Prisma queries and
 * the real data-table adapter against a Postgres that has the migrations
 * applied, and they REQUIRE `TEST_DATABASE_URL`: the setup file throws when it
 * is missing, so this suite can never "pass" by silently skipping.
 *
 * Point it at a throwaway database only. Each test works in freshly generated
 * workspace ids, so runs do not collide, but nothing is cleaned up afterwards.
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
    setupFiles: ['test/db-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
