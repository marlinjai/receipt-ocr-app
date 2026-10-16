import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * The equality check on a LOCAL COPY of production (`pnpm check:copy`): it
 * computes every finance figure, runs the assignment-cell migration on the copy
 * and computes them again. It needs `COPY_DATABASE_URL` pointing at a restored
 * backup on this machine (see scripts/assignment-cells.copycheck.ts) and refuses
 * any other host. It writes to that copy, so never point it at a database you
 * want to keep unchanged.
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
    include: ['scripts/**/*.copycheck.ts'],
    setupFiles: ['test/copy-setup.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
