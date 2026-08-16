import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MCP_TRANSPORT_CAP_MS,
  FOREGROUND_TIMEOUT_CEILING_MS,
  clampForegroundTimeoutMs,
  foregroundTimeoutHint,
} from './foreground-transport-cap';

// EI-6073 / EI-20645849301780712 — a FOREGROUND tool call that outruns the ~55s MCP transport
// cap is abandoned by the CLIENT with a generic failure, which is the SAME token a real non-zero
// exit produces. The agent then cannot tell "my command failed" from "the transport gave up", and
// because no abort reaches the child the command may still have run to completion invisibly.
// The fix is a clamp BELOW the cap so the tool always self-times-out first, with a distinct
// `status: 'timed_out'`. These tests pin the clamp, the hint, and — the part that stops the bug
// recurring — the invariant that EVERY foreground-capable tool actually applies it.

// The subject root is overridable so falsifiability can be proven against a MUTATED COPY outside
// the tree (scripts/mutation-probe.sh tier 2) instead of by editing the shared checkout, which a
// git-sync sweep can commit mid-probe.
const TOOLS_DIR = process.env.PROBE_AGENT_TOOLS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..');

describe('clampForegroundTimeoutMs — keep a foreground run under the MCP transport cap (EI-6073)', () => {
  it('caps the ceiling below the transport cap (with serialize headroom)', () => {
    expect(FOREGROUND_TIMEOUT_CEILING_MS).toBeLessThan(MCP_TRANSPORT_CAP_MS);
  });

  // The ceiling and the cap are two numbers that must stay apart; a "just bump it a bit" edit
  // that leaves the ceiling technically-below the cap but with no room to serialize a response
  // re-opens the same dead window more subtly. Require real headroom, not mere inequality.
  it('leaves at least 3s of headroom to serialize the response', () => {
    expect(MCP_TRANSPORT_CAP_MS - FOREGROUND_TIMEOUT_CEILING_MS).toBeGreaterThanOrEqual(3_000);
  });

  it('clamps a request ABOVE the ceiling down to it (the operator-core 120s default case)', () => {
    expect(clampForegroundTimeoutMs(120_000)).toBe(FOREGROUND_TIMEOUT_CEILING_MS);
    expect(clampForegroundTimeoutMs(600_000)).toBe(FOREGROUND_TIMEOUT_CEILING_MS);
  });

  it('leaves a request BELOW the ceiling untouched (a fast package is unaffected)', () => {
    expect(clampForegroundTimeoutMs(5_000)).toBe(5_000);
    expect(clampForegroundTimeoutMs(FOREGROUND_TIMEOUT_CEILING_MS)).toBe(FOREGROUND_TIMEOUT_CEILING_MS);
  });
});

describe('foregroundTimeoutHint — actionable hint on a clamped timeout (EI-6073)', () => {
  const RERUN = 'capability:bash { …same command…, run_in_background: true }';

  it('on a timed_out status → points to run_in_background + bash_output', () => {
    const h = foregroundTimeoutHint('timed_out', FOREGROUND_TIMEOUT_CEILING_MS, RERUN);
    expect(h).toMatch(/run_in_background/);
    expect(h).toMatch(/capability:bash_output/);
    expect(h).toContain('50s'); // the clamped ceiling, human-readable
  });

  it("carries the CALLER's own re-run invocation, not a hardcoded sibling tool's", () => {
    const asBash = foregroundTimeoutHint('timed_out', FOREGROUND_TIMEOUT_CEILING_MS, RERUN);
    expect(asBash).toContain('capability:bash {');
    const asInspect = foregroundTimeoutHint(
      'timed_out',
      FOREGROUND_TIMEOUT_CEILING_MS,
      'capability:inspect { …same args…, run_in_background: true }',
    );
    expect(asInspect).toContain('capability:inspect {');
    expect(asInspect).not.toContain('capability:bash {');
  });

  // EI-20645849301780712 was filed as "I could not tell whether the command was still running".
  // Saying so is the whole point of the hint, so assert it rather than trusting the prose.
  it('states the process tree was KILLED — the ambiguity the item was filed about', () => {
    const h = foregroundTimeoutHint('timed_out', FOREGROUND_TIMEOUT_CEILING_MS, RERUN);
    expect(h).toMatch(/KILLED/);
    expect(h).toMatch(/nothing is still running/i);
  });

  it('is EMPTY for any non-timeout status (completed / failed / killed) — no false hint', () => {
    expect(foregroundTimeoutHint('completed', FOREGROUND_TIMEOUT_CEILING_MS, RERUN)).toBe('');
    expect(foregroundTimeoutHint('failed', FOREGROUND_TIMEOUT_CEILING_MS, RERUN)).toBe('');
    expect(foregroundTimeoutHint('killed', FOREGROUND_TIMEOUT_CEILING_MS, RERUN)).toBe('');
  });
});

/**
 * EI-18776865728050036 / EI-20645849301780712 — the CLASS guard, not a per-tool patch.
 *
 * A tool dispatched FOREGROUND over the papercusp-su MCP transport gets ~55s (EI-6073). A tool
 * that declares a longer budget cannot honour it: the transport kills the call first and the
 * agent sees `MCP error -32603: write CONNECTION_CLOSED 127.0.0.1:6432` — an error naming the
 * DATABASE, which sends them off debugging PG. Measured: build:typecheck on packages/operator-core
 * (104.4s) failed 3/3 while libs/flags (2.1s) passed on the identical path.
 *
 * This guard EXISTED before capability:bash was fixed, and still did not catch it — because it
 * lived in `build/typecheck.test.ts` and enumerated only `build/typecheck.ts` + `testing/run.ts`.
 * A class guard whose list is incomplete reads exactly like a passing one. Two things changed
 * here: it now lives beside the module it guards (so the list is findable from the thing being
 * enumerated), and the list is complete. The lesson is the list, not the assertions — when you
 * add a foreground-capable tool, ADD THE ROW; that is the entire point.
 */
const FOREGROUND_CAPABLE_TOOLS = [
  'capability/bash.ts',
  'capability/inspect.ts',
  'testing/run.ts',
  'build/typecheck.ts',
  'code/run.ts',
];

describe('every foreground-capable tool applies the clamp (EI-20645849301780712)', () => {
  it('clamping a budget far above the cap still lands below it', () => {
    // 900_000 is MAX_TIMEOUT_MS on build:typecheck / testing:run — the worst case a caller can ask
    // for; 600_000 was capability:bash's, and the one the transport could never actually deliver.
    expect(clampForegroundTimeoutMs(900_000)).toBeLessThan(MCP_TRANSPORT_CAP_MS);
    expect(clampForegroundTimeoutMs(600_000)).toBeLessThan(MCP_TRANSPORT_CAP_MS);
  });

  it.each(FOREGROUND_CAPABLE_TOOLS)('%s imports the clamp from the shared module and calls it', (rel) => {
    const src = readFileSync(join(TOOLS_DIR, rel), 'utf8');

    // Imported from the ONE shared module — not re-derived, and not reached for by importing a
    // peer tool (the shape that hid the bash miss in the first place).
    expect(src, `${rel} must import from capability/foreground-transport-cap`).toMatch(
      /from '(\.|\.\.)\/(capability\/)?foreground-transport-cap'/,
    );
    // ...and actually APPLIED, not merely imported for its description string. build:typecheck
    // and testing:run interpolate FOREGROUND_TIMEOUT_CEILING_MS into their arg docs, so an
    // import-only assertion would pass for a tool that never clamps a single run.
    expect(src, `${rel} must CALL clampForegroundTimeoutMs, not just import it`).toMatch(
      /clampForegroundTimeoutMs\(/,
    );
    // Nobody may re-declare the constants locally and drift from the shared pair.
    expect(src, `${rel} must not redeclare the transport constants`).not.toMatch(
      /(const|let)\s+(MCP_TRANSPORT_CAP_MS|FOREGROUND_TIMEOUT_CEILING_MS)\s*=/,
    );
    // The teeth: the UN-CLAMPED form is what shipped in each of these and what a revert would
    // restore — the raw requested budget assigned straight to the value handed to the spawn.
    // Covers both arg spellings in play (`args.timeout` in capability:bash, `args.timeoutMs`
    // in build:typecheck / testing:run).
    expect(src, `${rel} passes its raw default straight to the spawn — the transport will kill it`)
      .not.toMatch(/const\s+timeoutMs\s*=\s*args\.timeout(Ms)?\s*\?\?/);
    // A timeout that names no escape route is how an agent ends up hand-rolling `npx tsc -p .`
    // — which checks ZERO files here and reads as clean.
    expect(src, `${rel} timeout branch must point at the detached run`).toMatch(/run_in_background/);
  });

  // CALIBRATION (permanent control): the assertions above must be capable of FAILING. A guard
  // that has only ever seen passing input is not evidence. These deliberately-wrong sources stay
  // in the test file so the check is proven falsifiable on every run, with no tree mutation.
  it('the same assertions REJECT a tool that imports the clamp but never calls it', () => {
    const importOnly = `import { FOREGROUND_TIMEOUT_CEILING_MS } from './foreground-transport-cap';\n` +
      `const timeoutMs = args.timeout ?? 120_000;\n`;
    expect(importOnly).toMatch(/from '(\.|\.\.)\/(capability\/)?foreground-transport-cap'/);
    expect(importOnly).not.toMatch(/clampForegroundTimeoutMs\(/); // ← the real guard would fail here
  });

  it('the same assertions REJECT a tool that redeclares the ceiling locally', () => {
    const redeclared = `const FOREGROUND_TIMEOUT_CEILING_MS = 240_000;\n`;
    expect(redeclared).toMatch(/(const|let)\s+FOREGROUND_TIMEOUT_CEILING_MS\s*=/); // ← would fail
  });
});
