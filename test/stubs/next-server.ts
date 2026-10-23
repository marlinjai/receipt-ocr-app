/**
 * Test-only stub for `next/server`.
 *
 * The `@marlinjai/auth-brain-nextjs` barrel re-exports middleware helpers that
 * `import 'next/server'` at module load. The unit tests only exercise the pure
 * door logic (`matchWorkspaces`), never the middleware, and vitest's node
 * resolver cannot follow Next's `./server` subpath export. Aliasing the
 * specifier to this stub (see vitest.config.ts) lets the barrel load without
 * pulling in the Next runtime. The classes are never instantiated by the tests.
 */
export class NextRequest {}
export class NextResponse {}

/**
 * `after` runs work once the response is sent (settling message queues after
 * an answer, say). The tests that call an action directly assert what the
 * action itself did; the deferred work is tested on its own, so here it is
 * dropped rather than left running against a database the test closes.
 */
export function after(task: unknown): void {
  void task;
}
