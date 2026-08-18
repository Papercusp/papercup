/**
 * Vitest SETUP for coverage attribution — publishes "which test is running right now" so the
 * in-process dispatcher hooks can stamp it onto the evidence they write.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-004).
 *
 * WHY A SETUP FILE AND NOT A REPORTER. A vitest reporter runs in the MAIN process; the tests —
 * and the in-process Hono app / MCP dispatcher they drive — run in FORKS. The ambient slot the
 * hooks read is fork-local, so only code running inside the fork can write it. `setupFiles` is
 * that code.
 *
 * ⚠ WHY IT REGISTERS NOTHING WHEN DISARMED. This file is loaded once per test FILE across two
 * whole workspaces, so its disarmed cost is the cost of the instrumentation to everyone who is
 * not using it. Disarmed it is: one module evaluation and one env read — the `beforeEach` /
 * `afterEach` / `afterAll` hooks are never registered at all, so no per-test work is added to
 * any ordinary run. That is also why the arming check is duplicated here rather than left to
 * the sink: a hook that runs and then returns early still costs a hook per test.
 *
 * SCOPE: wired into `packages/operator-core` and `apps/operator` only — the two workspaces
 * whose tests can actually reach a route or a tool dispatch. Adding it to the shared setup list
 * in `@papercusp/test-config` would load it for every workspace in the monorepo to observe
 * traffic none of them can generate.
 */

import { afterAll, afterEach, beforeEach, expect } from 'vitest';
import { toWorkspaceRel } from '@papercusp/test-config/admin-test-runs-reporter';
import { isAttributionArmed, setAmbientTestContext } from './context';
import { flushTrafficEvidence } from './sink';

if (isAttributionArmed()) {
  beforeEach(() => {
    // `expect.getState()` is vitest's own per-test state — the same object the built-in
    // matchers read — so `currentTestName` and `testPath` are exactly what the runner believes
    // is executing, with no parallel bookkeeping to drift from it.
    const s = expect.getState();
    setAmbientTestContext({
      // Relativized through the reporter's own function so this path and `test_runs.file_path`
      // are byte-identical — they are the join key. See `toWorkspaceRel`'s doc comment.
      file: s.testPath ? toWorkspaceRel(s.testPath) : null,
      case: s.currentTestName ?? null,
    });
  });

  afterEach(() => {
    // Cleared between tests so a call made OUTSIDE a test body (a module-scope side effect, an
    // async handler that outlived its test) is attributed to no test rather than to whichever
    // test happened to run last. A wrong attribution is worse than a missing one: it reads as
    // real coverage that no test actually provides.
    setAmbientTestContext(null);
  });

  afterAll(async () => {
    // The sink's own debounce is unref'd (it must never hold a process open), so the tail of a
    // file's traffic could otherwise be lost when the fork exits promptly. This is the
    // deterministic drain; `beforeExit` in the sink remains the backstop for the cross-process
    // case, where no vitest lifecycle exists.
    await flushTrafficEvidence();
  });
}
