import { describe, it, expect, vi } from 'vitest';
import {
  isEnvFailureExit,
  recordImplementWorkerExit,
  ENV_FAILURE_RUNTIME_FLOOR_MS,
  CONTEXT_OVERFLOW_ESCALATE_CAP,
  TIMEOUT_ESCALATE_CAP,
  type ImplementWorkerExitDeps,
} from './implement-worker-exit';

describe('isEnvFailureExit (EI-406 classifier)', () => {
  it('a clean exit (0) is never an env failure — it resolved or exited-0-without-resolve', () => {
    expect(isEnvFailureExit({ exitCode: 0, runtimeMs: 2_000, stdout: 'weekly limit' }).env).toBe(false);
  });

  describe('EI-9127: exit-0 tooling-unavailable deaths (storm-collector — 4 live cases)', () => {
    it('EI-9107: "papercusp MCP server failed to connect ... no Bash/Edit/ToolSearch fallback" is an env failure despite exit 0', () => {
      const v = isEnvFailureExit({
        exitCode: 0,
        runtimeMs: 244_000,
        stdout:
          'Diagnosed: papercusp MCP server failed to connect and this runner has no Bash/Edit/ToolSearch fallback, ' +
          'so no code change, no tests, and no `improvements:resolve` call were possible; re-dispatch to a healthy runner.',
      });
      expect(v.env).toBe(true);
      expect(v.reason).toMatch(/tooling unavailable/);
      expect(v.class).toBeUndefined(); // generic env leg — tags 'worker-exit-backedge-env', rolled back indefinitely
    });

    it('EI-9021: "runtime is missing its platform MCP tools, Bash, and code-edit tools" is an env failure despite exit 0', () => {
      const v = isEnvFailureExit({
        exitCode: 0,
        runtimeMs: 220_000,
        stdout:
          'I am stopping here rather than fabricating a resolve I cannot verify.\n\n' +
          'ESCALATE — implement-worker runtime is missing its platform MCP tools, Bash, and code-edit tools; ' +
          'EI-9021 cannot be reproduced, fixed, tested, or resolved in this context.',
      });
      expect(v.env).toBe(true);
      expect(v.reason).toMatch(/tooling unavailable/);
    });

    it('EI-9116: "this worker cannot call `improvements:resolve` (no platform MCP tools, no shell, no edit)" is an env failure despite exit 0', () => {
      const v = isEnvFailureExit({
        exitCode: 0,
        runtimeMs: 652_000,
        stdout:
          'ESCALATE — EI-9116 is a needs-human gateway-death phantom, and this worker cannot call ' +
          '`improvements:resolve` (no platform MCP tools, no shell, no edit) to record it.',
      });
      expect(v.env).toBe(true);
      expect(v.reason).toMatch(/tooling unavailable/);
    });

    it('WI-3795: "platform tools ... shell, and code-edit tools are all absent" is an env failure despite exit 0', () => {
      const v = isEnvFailureExit({
        exitCode: 0,
        runtimeMs: 286_000,
        stdout:
          'ESCALATE — WI-3795 not resolvable from this session: platform tools (incl. `improvements:resolve`), ' +
          'shell, and code-edit tools are all absent; separately, the bug itself is a native-SIGABRT root cause ' +
          'that warrants a `needs-human` resolution rather than an auto-fix.',
      });
      expect(v.env).toBe(true);
      expect(v.reason).toMatch(/tooling unavailable/);
    });

    it('a real exit-0-forgot-to-resolve worker bug (no tooling complaint) is still NOT env — unchanged behavior', () => {
      const v = isEnvFailureExit({
        exitCode: 0,
        runtimeMs: 640_000,
        stdout: 'Reproduced the bug, wrote the fix and a regression test. Now let me run the affected suite to confirm nothing else broke.',
      });
      expect(v.env).toBe(false);
    });
  });

  it('the live EI-75 weekly-limit DOA is an env failure', () => {
    const v = isEnvFailureExit({
      exitCode: 1,
      runtimeMs: 3_000,
      stdout: "You've hit your weekly limit · resets Jun 18, 7am (America/New_York)",
    });
    expect(v.env).toBe(true);
    expect(v.reason).toMatch(/env signature/);
  });

  it.each([
    ['401', 'request failed with status 401'],
    ['403 org block', 'Your organization has disabled subscription access — 403'],
    ['unauthorized', 'Error: Unauthorized'],
    ['credential', 'no valid credential found'],
    ['rate limit', 'you are being rate-limited, try again later'],
    ['connectivity', 'connect ECONNREFUSED 127.0.0.1:8788'],
    // EI-6876: transient upstream model-API 5xx / overload — NOT the item's fault.
    ['the live EI-6876 server-error-mid-response', 'API Error: Server error mid-response. The response above may be incomplete.'],
    ['overloaded (529)', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'],
    ['internal server error (500)', 'API Error: 500 Internal server error'],
    ['service unavailable (503)', 'upstream returned 503 Service Unavailable'],
    ['bad gateway (502)', 'API Error: 502 Bad Gateway'],
    ['gateway timeout (504)', 'API Error: 504 Gateway Timeout'],
    // EI-6890: the inference-gateway's own transient-upstream wrapper — NUMERIC status +
    // "upstream error: fetch failed" / "server-side issue", NOT the English 5xx phrasings
    // above. The live EI-6476 death slipped through before this and filed a false EI.
    ['the live EI-6476 inference-gateway 502', 'API Error: 502 inference-gateway upstream error: fetch failed. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:8788).'],
    ['a bare numeric 5xx with no English phrasing', 'API Error: 503'],
    ['undici fetch-failed connectivity death', 'TypeError: fetch failed'],
    // EI-7591/EI-7426: an Anthropic USAGE-CREDITS / billing exhaustion — a credential/billing-class
    // outage, self-healing once credits are restored; NOT the item's fault. The live death slipped
    // EVERY pattern above ("credits" is not matched by the /credential/ pattern), so it was charged
    // + tagged plain 'worker-exit-backedge' and filed a false "lane broken" EI (EI-7591).
    [
      'the live EI-7426 usage-credits exhaustion',
      'API Error: Usage credits required for 1M context · turn on usage credits at claude.ai/settings/usage, or use --model to switch to standard context',
    ],
    ['a bare "credits required" billing message', 'Error: purchase more credits required to continue'],
  ])('classifies %s as env failure', (_label, stdout) => {
    // A long substantive run (well past the DOA floor) so the ONLY thing that can
    // class these env is the new upstream-5xx signature, not the sub-floor DOA rule.
    expect(isEnvFailureExit({ exitCode: 1, runtimeMs: ENV_FAILURE_RUNTIME_FLOOR_MS + 500_000, stdout }).env).toBe(true);
  });

  it('a non-zero sub-floor near-empty exit is a dead-on-arrival env failure', () => {
    const v = isEnvFailureExit({ exitCode: 1, runtimeMs: 2_000, stdout: '', stderr: '' });
    expect(v.env).toBe(true);
    expect(v.reason).toMatch(/dead-on-arrival/);
  });

  it('EI-7644: a non-zero exit WELL PAST the DOA floor with ZERO captured output is a "silent death" env failure, not charged (real observed case: EI-7520\'s dispatch, exit 1 after 701s, no output)', () => {
    const v = isEnvFailureExit({ exitCode: 1, runtimeMs: 701_000, stdout: '', stderr: '' });
    expect(v.env).toBe(true);
    expect(v.reason).toMatch(/silent death/);
    expect(v.class).toBeUndefined(); // generic env leg — tags 'worker-exit-backedge-env', same as the DOA case
  });

  it('EI-7644: a non-zero exit past the DOA floor with SOME (even short) output is NOT a silent death — still a genuine attempt', () => {
    const v = isEnvFailureExit({ exitCode: 1, runtimeMs: 701_000, stdout: 'oops', stderr: '' });
    expect(v.env).toBe(false);
  });

  // WI-3053: filed as a suspected classifier GAP ("bare SIGTERM mid-run, well before the
  // configured timeout, no env/context-overflow text match, falls into charged
  // 'worker-exit-backedge' with no diagnosis") citing two live examples (EI-7220 @927s vs a
  // 900-2700s budget, EI-7439 @2223s vs a 2700s budget, both empty stdout/stderr). Verified
  // ALREADY CLOSED by EI-7644's later "silent death" leg (added independently, above): a bare
  // SIGTERM mid-run with truly empty output is exactly a silent death, well past the DOA floor
  // and not near the configured timeout — no gap remains for this exact shape.
  it('WI-3053: a bare SIGTERM well before the configured timeout, with empty output, is a silent-death env failure (not a raw charged worker-exit-backedge)', () => {
    const v1 = isEnvFailureExit({ exitCode: 143, runtimeMs: 927_000, configuredTimeoutMs: 2_700_000, stdout: '', stderr: '' });
    expect(v1.env).toBe(true);
    expect(v1.reason).toMatch(/silent death/);
    const v2 = isEnvFailureExit({ exitCode: 143, runtimeMs: 2_223_000, configuredTimeoutMs: 2_700_000, stdout: '', stderr: '' });
    expect(v2.env).toBe(true);
    expect(v2.reason).toMatch(/silent death/);
  });

  it('a genuine worker failure (long run, substantive output, no env signature) is NOT env', () => {
    const v = isEnvFailureExit({
      exitCode: 1,
      runtimeMs: ENV_FAILURE_RUNTIME_FLOOR_MS + 600_000,
      stdout: 'Reproduced the bug, wrote a regression test, but the fix attempt still fails 2 assertions. '.repeat(6),
    });
    expect(v.env).toBe(false);
  });

  it('a non-zero exit with substantive output under the floor but no signature is NOT env (it did real work fast)', () => {
    const v = isEnvFailureExit({
      exitCode: 1,
      runtimeMs: 10_000,
      stdout: 'x'.repeat(500), // > 200 chars → not the empty-DOA shape, no signature → genuine
    });
    expect(v.env).toBe(false);
  });

  // EI-23881176965254978 — the Codex model-capacity wall. Deliberately shaped to be
  // NON-VACUOUS: the runtime is well past the DOA floor and the output is non-empty, so the
  // dead-on-arrival and silent-death rules below both decline it. Without the capacity pattern
  // in ENV_FAILURE_PATTERNS this returns env:false — i.e. the death is CHARGED as a real attempt
  // and tagged plain 'worker-exit-backedge', which the orphaned-dispatch watchdog then reads as
  // "the implement lane is broken". Same self-amplifying false-EI loop as EI-6876 / EI-6890 /
  // EI-7591, one signature later.
  it('EI-23881176965254978: a Codex model-capacity wall is an env failure, not a charged attempt', () => {
    const v = isEnvFailureExit({
      exitCode: 1,
      runtimeMs: ENV_FAILURE_RUNTIME_FLOOR_MS + 210_000,
      stdout: 'Selected model is at capacity. Please try a different model.',
    });
    expect(v.env).toBe(true);
  });

  it('WI-716: "Prompt is too long" is classed env + tagged context-overflow (not a generic env signature)', () => {
    const v = isEnvFailureExit({
      exitCode: 1,
      runtimeMs: 400_000, // a real long reproduce+fix run, not a DOA
      stdout: 'reproducing the bug...\n'.repeat(200) + 'worker exit 1 ... Prompt is too long',
    });
    expect(v.env).toBe(true);
    expect(v.class).toBe('context-overflow');
    expect(v.reason).toMatch(/context overflow/);
  });

  it('WI-716: an underlying "exceeds the context window" API message also classifies as context-overflow', () => {
    const v = isEnvFailureExit({
      exitCode: 1,
      runtimeMs: 200_000,
      stdout: 'x'.repeat(300) + '\nrequest exceeds the model context window',
    });
    expect(v.class).toBe('context-overflow');
  });

  it('WI-2162: a SIGTERM (143) at/past the configured timeout classes as timeout, even with NO output', () => {
    const v = isEnvFailureExit({ exitCode: 143, runtimeMs: 2_702_000, configuredTimeoutMs: 2_700_000 });
    expect(v.env).toBe(true);
    expect(v.class).toBe('timeout');
    expect(v.reason).toMatch(/worker timeout/);
  });

  it('WI-2162: the live EI-6942-shape death (exit 143 at 2702s vs a 2700s configured limit) classes as timeout', () => {
    const v = isEnvFailureExit({
      exitCode: 143,
      runtimeMs: 2_702_000,
      configuredTimeoutMs: 2_700_000,
      stdout: 'Let me check for any existing plan/design for the periodic fix and the git history',
    });
    expect(v.class).toBe('timeout');
  });

  it('WI-2162: SIGKILL (137) also classes as timeout (the grace-period escalation path)', () => {
    const v = isEnvFailureExit({ exitCode: 137, runtimeMs: 2_705_000, configuredTimeoutMs: 2_700_000 });
    expect(v.class).toBe('timeout');
  });

  it('WI-2162: a run well UNDER the configured timeout is NOT a timeout death even at exit 143 (e.g. an external SIGTERM/cancel)', () => {
    const v = isEnvFailureExit({ exitCode: 143, runtimeMs: 60_000, configuredTimeoutMs: 2_700_000 });
    expect(v.class).not.toBe('timeout');
  });

  it('WI-2162: exit 143 with NO configuredTimeoutMs known falls through unchanged (not misclassified)', () => {
    const v = isEnvFailureExit({ exitCode: 143, runtimeMs: 2_702_000 });
    expect(v.class).not.toBe('timeout');
  });

  it('WI-2162: a slightly-under-limit runtime within jitter tolerance still classes as timeout', () => {
    const v = isEnvFailureExit({ exitCode: 143, runtimeMs: 2_695_000, configuredTimeoutMs: 2_700_000 });
    expect(v.class).toBe('timeout');
  });

  it('WI-2162: context-overflow text wins over the timeout shape when BOTH are present (more specific signal first)', () => {
    const v = isEnvFailureExit({
      exitCode: 143,
      runtimeMs: 2_702_000,
      configuredTimeoutMs: 2_700_000,
      stdout: 'Prompt is too long',
    });
    expect(v.class).toBe('context-overflow');
  });

  it('WI-2162: a normal exit-1 crash at a long runtime with NO timeout config is unaffected (regression guard)', () => {
    const v = isEnvFailureExit({
      exitCode: 1,
      runtimeMs: ENV_FAILURE_RUNTIME_FLOOR_MS + 600_000,
      stdout: 'Reproduced the bug, wrote a regression test, but the fix attempt still fails 2 assertions. '.repeat(6),
    });
    expect(v.env).toBe(false);
  });

  describe('EI-10568: MODULE_NOT_FOUND worker-bootstrap crashes are env failures', () => {
    const LIVE_STACK =
      "node:internal/modules/cjs/loader:1261\n  throw err;\n  ^\n\nError: Cannot find module '/some/entry.js'\n" +
      '    at Module._resolveFilename (node:internal/modules/cjs/loader:1258:15)\n' +
      '    at Module._load (node:internal/modules/cjs/loader:1084:27)\n' +
      '    at TracingChannel.traceSync (node:diagnostics_channel:344:14)\n' +
      '    at wrapModuleLoad (node:internal/modules/cjs/loader:255:19)\n' +
      '    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)\n' +
      "    at node:internal/main/run_main_module:33:47 {\n  code: 'MODULE_NOT_FOUND',\n  requireStack: []\n}\n\n" +
      'Node.js v25.9.0';

    it('the live EI-10533 shape (exit 1, 0s, MODULE_NOT_FOUND stack on stderr) is an env failure, not charged', () => {
      const v = isEnvFailureExit({ exitCode: 1, runtimeMs: 0, stderr: LIVE_STACK });
      expect(v.env).toBe(true);
      expect(v.reason).toMatch(/MODULE_NOT_FOUND/);
      // No context-overflow/timeout class — the generic env-failure rollback applies.
      expect(v.class).toBeUndefined();
    });

    it('classifies even when the stack trace text is long (well over the 200-char DOA-floor bound) — the pattern match short-circuits before the DOA fallback', () => {
      const v = isEnvFailureExit({ exitCode: 1, runtimeMs: 5_000, stderr: LIVE_STACK });
      expect(LIVE_STACK.length).toBeGreaterThan(200);
      expect(v.env).toBe(true);
    });

    it('ERR_MODULE_NOT_FOUND (the ESM-loader variant) is also an env failure', () => {
      const v = isEnvFailureExit({
        exitCode: 1,
        runtimeMs: 0,
        stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@papercusp/foo' imported from /x/y.mjs",
      });
      expect(v.env).toBe(true);
      expect(v.reason).toMatch(/MODULE_NOT_FOUND/);
    });

    it('a plain "Cannot find module" message (no error code) is also caught', () => {
      const v = isEnvFailureExit({ exitCode: 1, runtimeMs: 0, stderr: "Cannot find module './missing-file'" });
      expect(v.env).toBe(true);
    });

    it('a genuine worker crash mentioning an unrelated "module" word is NOT misclassified (regression guard)', () => {
      const v = isEnvFailureExit({
        exitCode: 1,
        runtimeMs: ENV_FAILURE_RUNTIME_FLOOR_MS + 600_000,
        stdout: 'Refactored the auth module and updated its tests, but one assertion still fails on the edge case. '.repeat(4),
      });
      expect(v.env).toBe(false);
    });
  });
});

function fakeDeps(overrides: Partial<ImplementWorkerExitDeps> = {}): {
  deps: ImplementWorkerExitDeps;
  calls: {
    markOrphaned: Array<[string, string, string | undefined]>;
    mergePayload: Array<[string, Record<string, unknown>]>;
    routeToLeaderTriage: Array<[string, string]>;
  };
} {
  const calls = {
    markOrphaned: [] as Array<[string, string, string | undefined]>,
    mergePayload: [] as Array<[string, Record<string, unknown>]>,
    routeToLeaderTriage: [] as Array<[string, string]>,
  };
  const deps: ImplementWorkerExitDeps = {
    markOrphaned: async (id, by, detail) => {
      calls.markOrphaned.push([id, by, detail]);
      return true;
    },
    mergePayload: async (id, patch) => {
      calls.mergePayload.push([id, patch]);
      return null;
    },
    getPayload: async () => null, // no prior contextOverflowDeaths unless a test overrides it
    routeToLeaderTriage: async (id, blockedReason) => {
      calls.routeToLeaderTriage.push([id, blockedReason]);
      return null;
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('recordImplementWorkerExit (EI-404 back-edge + EI-406 rollback)', () => {
  it('marks the open ledger row orphaned at exit with by=worker-exit-backedge + detail', async () => {
    const { deps, calls } = fakeDeps();
    const res = await recordImplementWorkerExit(
      { dispatchId: 'd1', itemId: 'EI-9', attempt: 1, exitCode: 1, runtimeMs: 4_000, stdout: 'fix failed: 2 assertions red'.repeat(20) },
      deps,
    );
    expect(res.marked).toBe(true);
    expect(calls.markOrphaned).toHaveLength(1);
    expect(calls.markOrphaned[0][0]).toBe('d1');
    expect(calls.markOrphaned[0][1]).toBe('worker-exit-backedge');
    expect(calls.markOrphaned[0][2]).toMatch(/worker exit 1/);
  });

  it('env-failure rolls the attempt counter back (does NOT charge) — EI-406', async () => {
    const { deps, calls } = fakeDeps();
    const res = await recordImplementWorkerExit(
      { dispatchId: 'd2', itemId: 'EI-75', attempt: 2, exitCode: 1, runtimeMs: 3_000, stdout: "You've hit your weekly limit · resets Jun 18, 7am" },
      deps,
    );
    expect(res.charged).toBe(false);
    expect(res.envReason).toBeTruthy();
    expect(calls.mergePayload).toEqual([['EI-75', { implementAttempts: 1 }]]);
    expect(calls.markOrphaned[0][2]).toMatch(/env-failure/);
    // Tagged distinctly so the orphaned-dispatch watchdog excludes it from the "lane broken" signal.
    expect(calls.markOrphaned[0][1]).toBe('worker-exit-backedge-env');
  });

  it('EI-6876: a transient upstream "Server error mid-response" rolls the attempt back + tags -env (not a "lane broken" orphan)', async () => {
    const { deps, calls } = fakeDeps();
    const res = await recordImplementWorkerExit(
      {
        dispatchId: 'd-6569',
        itemId: 'EI-6569',
        attempt: 1,
        exitCode: 1,
        runtimeMs: 866_000, // the real EI-6569 death: a long run, not a DOA
        stdout: 'API Error: Server error mid-response. The response above may be incomplete.',
      },
      deps,
    );
    // Transient provider 5xx says nothing about the item → do NOT charge the attempt.
    expect(res.charged).toBe(false);
    expect(res.envReason).toBeTruthy();
    expect(calls.mergePayload).toEqual([['EI-6569', { implementAttempts: 0 }]]);
    // Tagged -env so the orphaned-dispatch watchdog EXCLUDES it from the "lane broken"
    // signal — no self-amplifying EI (the loop that produced EI-6876).
    expect(calls.markOrphaned[0][1]).toBe('worker-exit-backedge-env');
    expect(calls.markOrphaned[0][2]).toMatch(/env-failure/);
  });

  it('EI-6890: the live inference-gateway 502 death rolls the attempt back + tags -env (not a "lane broken" orphan)', async () => {
    const { deps, calls } = fakeDeps();
    const res = await recordImplementWorkerExit(
      {
        dispatchId: 'd-6476',
        itemId: 'EI-6476',
        attempt: 1,
        exitCode: 1,
        runtimeMs: 249_000, // the real EI-6476 death: a 249s run, well past the DOA floor
        stdout:
          'API Error: 502 inference-gateway upstream error: fetch failed. This is a server-side issue, ' +
          'usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:8788).',
      },
      deps,
    );
    // A transient inference-gateway 502 says nothing about the item → do NOT charge the attempt.
    expect(res.charged).toBe(false);
    expect(res.envReason).toBeTruthy();
    expect(calls.mergePayload).toEqual([['EI-6476', { implementAttempts: 0 }]]);
    // Tagged -env so the orphaned-dispatch watchdog EXCLUDES it from the "lane broken"
    // signal — the fix for the EI-6476 → EI-6890 self-amplifying noise loop.
    expect(calls.markOrphaned[0][1]).toBe('worker-exit-backedge-env');
    expect(calls.markOrphaned[0][2]).toMatch(/env-failure/);
  });

  it('a credential outage on attempt 1 rolls back to 0 (never negative)', async () => {
    const { deps, calls } = fakeDeps();
    await recordImplementWorkerExit(
      { dispatchId: 'd3', itemId: 'EI-1', attempt: 1, exitCode: 1, runtimeMs: 1_500, stdout: '', stderr: '' },
      deps,
    );
    expect(calls.mergePayload).toEqual([['EI-1', { implementAttempts: 0 }]]);
  });

  it('a genuine worker failure stays charged (no rollback)', async () => {
    const { deps, calls } = fakeDeps();
    const res = await recordImplementWorkerExit(
      {
        dispatchId: 'd4',
        itemId: 'EI-2',
        attempt: 2,
        exitCode: 1,
        runtimeMs: ENV_FAILURE_RUNTIME_FLOOR_MS + 300_000,
        stdout: 'Tried the fix, tests still red after 3 iterations. '.repeat(10),
      },
      deps,
    );
    expect(res.charged).toBe(true);
    expect(calls.mergePayload).toHaveLength(0);
  });

  it('is a no-op when the row is already terminal (the worker DID resolve)', async () => {
    const { deps, calls } = fakeDeps({ markOrphaned: async () => false });
    const res = await recordImplementWorkerExit(
      { dispatchId: 'd5', itemId: 'EI-3', attempt: 1, exitCode: 0, runtimeMs: 120_000, stdout: 'resolved' },
      deps,
    );
    expect(res.marked).toBe(false);
    expect(calls.mergePayload).toHaveLength(0);
  });
});

describe('recordImplementWorkerExit — EI-1404 reset-hold', () => {
  // 2026-07-17 03:00 America/New_York == 07:00 UTC.
  const NOW = Date.parse('2026-07-17T07:00:00.000Z');

  it('the live shape ("resets 7am (America/New_York)") stamps dispatchHoldUntil alongside the attempt rollback', async () => {
    const { deps, calls } = fakeDeps();
    const res = await recordImplementWorkerExit(
      {
        dispatchId: 'd-1404',
        itemId: 'EI-89',
        attempt: 3,
        exitCode: 1,
        runtimeMs: 3_000,
        stdout: "worker exit 1 … You've hit your weekly limit · resets 7am (America/New_York)",
        nowMs: NOW,
      },
      deps,
    );
    expect(res.charged).toBe(false);
    expect(res.resetHold).toBeTruthy();
    // 7am America/New_York in July (EDT, UTC-4) == 11:00 UTC the same day.
    expect(new Date(res.resetHold!.holdUntilMs).toISOString()).toBe('2026-07-17T11:00:00.000Z');
    expect(calls.mergePayload).toEqual([
      ['EI-89', { implementAttempts: 2, dispatchHoldUntil: '2026-07-17T11:00:00.000Z' }],
    ]);
    expect(calls.markOrphaned[0][2]).toMatch(/dispatch held until 2026-07-17T11:00:00\.000Z/);
  });

  it('an env death WITHOUT a parseable reset time rolls the attempt back but does NOT stamp dispatchHoldUntil', async () => {
    const { deps, calls } = fakeDeps();
    await recordImplementWorkerExit(
      {
        dispatchId: 'd-75',
        itemId: 'EI-75',
        attempt: 2,
        exitCode: 1,
        runtimeMs: 3_000,
        // The older EI-75 fixture shape: a date, no clock time this parser targets.
        stdout: "You've hit your weekly limit · resets Jun 18, 7am",
        nowMs: NOW,
      },
      deps,
    );
    expect(calls.mergePayload).toEqual([['EI-75', { implementAttempts: 1 }]]);
  });

  it('a context-overflow death never computes a reset-hold even if the text mentions a time (its own escalation path wins)', async () => {
    const { deps, calls } = fakeDeps();
    const res = await recordImplementWorkerExit(
      {
        dispatchId: 'd-of',
        itemId: 'EI-716',
        attempt: 1,
        exitCode: 1,
        runtimeMs: 300_000,
        stdout: 'Prompt is too long — resets 7am (America/New_York) mentioned incidentally in a log line.',
        nowMs: NOW,
      },
      deps,
    );
    expect(res.resetHold).toBeUndefined();
    expect(calls.mergePayload[0][1]).not.toHaveProperty('dispatchHoldUntil');
  });
});

describe('recordImplementWorkerExit — WI-716 context-overflow bounded escalation', () => {
  const overflowInput = (over: Partial<Parameters<typeof recordImplementWorkerExit>[0]> = {}) => ({
    dispatchId: 'd-of',
    itemId: 'EI-716',
    attempt: 3,
    exitCode: 1,
    runtimeMs: 600_000,
    stdout: 'reproducing...\n'.repeat(100) + 'worker exit 1 ... Prompt is too long',
    ...over,
  });

  it('a FIRST context-overflow death (no prior) rolls the attempt back and persists deaths=1 — not escalated', async () => {
    const { deps, calls } = fakeDeps({ getPayload: async () => null });
    const res = await recordImplementWorkerExit(overflowInput(), deps);
    expect(res.charged).toBe(false);
    expect(res.contextOverflow).toEqual({ deaths: 1, escalated: false });
    expect(calls.mergePayload).toEqual([['EI-716', { contextOverflowDeaths: 1, implementAttempts: 2 }]]);
    expect(calls.markOrphaned[0][1]).toBe('worker-exit-backedge-context-overflow');
    expect(calls.markOrphaned[0][2]).toMatch(/context-overflow death 1\/2/);
  });

  it(`a ${CONTEXT_OVERFLOW_ESCALATE_CAP}th context-overflow death trips the cap: LEADER TRIAGE (status=blocked), attempt NOT rolled back`, async () => {
    const { deps, calls } = fakeDeps({ getPayload: async () => ({ contextOverflowDeaths: CONTEXT_OVERFLOW_ESCALATE_CAP - 1 }) });
    const res = await recordImplementWorkerExit(overflowInput({ attempt: 5 }), deps);
    expect(res.contextOverflow).toEqual({ deaths: CONTEXT_OVERFLOW_ESCALATE_CAP, escalated: true });
    // P-004/WI-5679: the death count persists, but the routing is to LEADER TRIAGE (status=blocked)
    // NOT payload.needsHuman — a repeatedly-overflowing item needs a leader to re-scope it, not the owner.
    expect(calls.mergePayload).toEqual([['EI-716', { contextOverflowDeaths: CONTEXT_OVERFLOW_ESCALATE_CAP }]]);
    expect(calls.mergePayload[0][1]).not.toHaveProperty('needsHuman');
    expect(calls.routeToLeaderTriage).toEqual([['EI-716', `context-overflow-escalated:${CONTEXT_OVERFLOW_ESCALATE_CAP}`]]);
    // NOT an implementAttempts rollback this time — status=blocked removes it from the
    // auto pool regardless of attempts, so no infinite rollback/re-dispatch loop.
    expect(calls.mergePayload[0][1]).not.toHaveProperty('implementAttempts');
    expect(calls.markOrphaned[0][2]).toMatch(/escalation cap tripped/);
  });

  it('a getPayload failure is treated as 0 prior deaths (best-effort — never throws)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, calls } = fakeDeps({ getPayload: async () => { throw new Error('pg down'); } });
    const res = await recordImplementWorkerExit(overflowInput(), deps);
    expect(res.contextOverflow).toEqual({ deaths: 1, escalated: false });
    expect(calls.mergePayload).toEqual([['EI-716', { contextOverflowDeaths: 1, implementAttempts: 2 }]]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('a generic env failure (weekly limit) never touches getPayload / contextOverflowDeaths', async () => {
    let getPayloadCalls = 0;
    const { deps, calls } = fakeDeps({ getPayload: async () => { getPayloadCalls++; return null; } });
    const res = await recordImplementWorkerExit(
      { dispatchId: 'd-env', itemId: 'EI-9', attempt: 2, exitCode: 1, runtimeMs: 3_000, stdout: "You've hit your weekly limit · resets Jun 18, 7am" },
      deps,
    );
    expect(res.contextOverflow).toBeUndefined();
    expect(getPayloadCalls).toBe(0);
    expect(calls.mergePayload).toEqual([['EI-9', { implementAttempts: 1 }]]);
  });
});

describe('recordImplementWorkerExit — WI-2162 worker-timeout bounded escalation', () => {
  const timeoutInput = (over: Partial<Parameters<typeof recordImplementWorkerExit>[0]> = {}) => ({
    dispatchId: 'd-to',
    itemId: 'EI-7203',
    attempt: 1,
    exitCode: 143,
    runtimeMs: 2_702_000,
    configuredTimeoutMs: 2_700_000,
    stdout: "Let me check for any existing plan/design for the periodic fix and the git history",
    ...over,
  });

  it('a FIRST timeout death (no prior) rolls the attempt back, persists deaths=1, tags -timeout — not escalated', async () => {
    const { deps, calls } = fakeDeps({ getPayload: async () => null });
    const res = await recordImplementWorkerExit(timeoutInput(), deps);
    expect(res.charged).toBe(false);
    expect(res.timeoutEscalation).toEqual({ deaths: 1, escalated: false });
    expect(calls.mergePayload).toEqual([['EI-7203', { timeoutDeaths: 1, implementAttempts: 0 }]]);
    expect(calls.markOrphaned[0][1]).toBe('worker-exit-backedge-timeout');
    expect(calls.markOrphaned[0][2]).toMatch(/worker-timeout death 1\/2/);
  });

  it(`a ${TIMEOUT_ESCALATE_CAP}th timeout death trips the cap: LEADER TRIAGE (status=blocked), attempt NOT rolled back`, async () => {
    const { deps, calls } = fakeDeps({ getPayload: async () => ({ timeoutDeaths: TIMEOUT_ESCALATE_CAP - 1 }) });
    const res = await recordImplementWorkerExit(timeoutInput({ attempt: 3 }), deps);
    expect(res.timeoutEscalation).toEqual({ deaths: TIMEOUT_ESCALATE_CAP, escalated: true });
    // P-004/WI-5679: death count persists, but routing is LEADER TRIAGE (status=blocked), not needsHuman.
    expect(calls.mergePayload).toEqual([['EI-7203', { timeoutDeaths: TIMEOUT_ESCALATE_CAP }]]);
    expect(calls.mergePayload[0][1]).not.toHaveProperty('needsHuman');
    expect(calls.routeToLeaderTriage).toEqual([['EI-7203', `invoke-timeout-escalated:${TIMEOUT_ESCALATE_CAP}`]]);
    expect(calls.mergePayload[0][1]).not.toHaveProperty('implementAttempts');
    expect(calls.markOrphaned[0][2]).toMatch(/escalation cap tripped/);
  });

  it('a getPayload failure is treated as 0 prior timeout deaths (best-effort — never throws)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, calls } = fakeDeps({ getPayload: async () => { throw new Error('pg down'); } });
    const res = await recordImplementWorkerExit(timeoutInput(), deps);
    expect(res.timeoutEscalation).toEqual({ deaths: 1, escalated: false });
    expect(calls.mergePayload).toEqual([['EI-7203', { timeoutDeaths: 1, implementAttempts: 0 }]]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('a timeout death is NEVER charged and is tagged distinctly from a generic worker crash', async () => {
    const { deps, calls } = fakeDeps({ getPayload: async () => null });
    const res = await recordImplementWorkerExit(timeoutInput(), deps);
    expect(res.charged).toBe(false);
    expect(calls.markOrphaned[0][1]).not.toBe('worker-exit-backedge');
  });

  it('a generic worker crash (exit 1, no timeout config) never touches getPayload / timeoutDeaths', async () => {
    let getPayloadCalls = 0;
    const { deps, calls } = fakeDeps({ getPayload: async () => { getPayloadCalls++; return null; } });
    const res = await recordImplementWorkerExit(
      { dispatchId: 'd-crash', itemId: 'EI-2', attempt: 2, exitCode: 1, runtimeMs: 900_000, stdout: 'fix attempt failed, 2 assertions red'.repeat(10) },
      deps,
    );
    expect(res.timeoutEscalation).toBeUndefined();
    expect(res.charged).toBe(true);
    expect(getPayloadCalls).toBe(0);
    expect(calls.mergePayload).toHaveLength(0);
  });
});
