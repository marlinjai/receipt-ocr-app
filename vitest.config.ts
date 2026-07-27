import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // The auth-brain-nextjs barrel imports 'next/server' at load; the door
      // unit tests never touch the middleware, and vitest's node resolver cannot
      // follow Next's subpath export. Point it at a bare stub for tests only.
      'next/server': path.resolve(__dirname, 'test/stubs/next-server.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Inline the wrapper so vite transforms it and the `next/server` alias above
    // applies inside its barrel (node's ESM loader would otherwise externalize
    // it and resolve `next/server` itself, ignoring the alias).
    server: {
      deps: {
        inline: ['@marlinjai/auth-brain-nextjs'],
      },
    },
  },
});
