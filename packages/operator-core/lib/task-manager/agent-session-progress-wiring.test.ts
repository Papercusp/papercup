/**
 * The agent-session progress census must stay WIRED into the reconcile routine.
 *
 * `agent-session-progress-census.test.ts` proves the census LOGIC is correct. It
 * cannot notice the failure that actually matters here: delete the call site in
 * `task-reconcile-action.ts` and all 9 of those tests still pass while the guard
 * silently becomes dead code. That is the exact class this census exists to
 * detect — something that stops running without anything going red — so the
 * wiring gets its own guard.
 *
 * The call site is a private function inside a module-scope
 * `registerSystemAction` callback, so there is nothing importable to assert
 * against; the subject is the source text. That makes the FIXTURE controls
 * load-bearing (sibling: `doc-claims/granular-lock-cross-domain.test.ts`): once
 * the live assertion goes green it stops being evidence that the judge can fail
 * at all, so the deliberately-unwired fixtures stay here permanently.
 *
 * Run: cd packages/operator-core && npx vitest run lib/task-manager/agent-session-progress-wiring.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// lib/task-manager → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ACTION = join(ROOT, 'packages/operator-core/lib/harness/routines/task-reconcile-action.ts');

/**
 * The anchor that proves the judge is reading the file it thinks it is. A
 * restructure that moves the routine elsewhere must fail LOUD here rather than
 * quietly satisfying the wiring assertions against an unrelated file.
 */
const REGISTRATION_ANCHOR = "registerSystemAction('task-reconcile'";

type WiringVerdict = {
  readonly registered: boolean;
  readonly importsCensus: boolean;
  readonly callsReporter: boolean;
  readonly ownWatermark: boolean;
};

function judgeWiring(source: string): WiringVerdict {
  return {
    registered: source.includes(REGISTRATION_ANCHOR),
    importsCensus: /from\s+'\.\.\/\.\.\/task-manager\/agent-session-progress-census'/.test(source),
    // The CALL, not the declaration — `async function reportAgentSessionProgress`
    // survives unwiring, so matching the bare identifier would pass on dead code.
    callsReporter: /await\s+reportAgentSessionProgress\s*\(/.test(source),
    // Its own watermark: a fault in the residue census must never suppress this one.
    ownWatermark: /lastAtMs:\s*lastProgressAtMs[\s\S]{0,120}?PROGRESS_INTERVAL_MS/.test(source),
  };
}

const wired = (over: Partial<Record<string, string>> = {}): string => `
import { censusAgentSessionProgress } from '../../task-manager/agent-session-progress-census';
${REGISTRATION_ANCHOR}, async (ctx) => {
  if (isMaintDue({ lastAtMs: lastProgressAtMs, nowMs, intervalMs: PROGRESS_INTERVAL_MS })) {
    lastProgressAtMs = nowMs;
    ${over.call ?? 'await reportAgentSessionProgress(ctx);'}
  }
});
async function reportAgentSessionProgress(ctx) {}
`;

/** The regression this guard exists to catch: the gate and the call deleted. */
const UNWIRED = `
import { censusAgentSessionProgress } from '../../task-manager/agent-session-progress-census';
${REGISTRATION_ANCHOR}, async (ctx) => {
  /* progress census call removed */
});
async function reportAgentSessionProgress(ctx) {}
`;

/** Subtler: the declaration survives, only the call site is gone. */
const DECLARED_BUT_NEVER_CALLED = `
${REGISTRATION_ANCHOR}, async (ctx) => {});
async function reportAgentSessionProgress(ctx) {}
`;

/** The judge pointed at the wrong file entirely. */
const WRONG_FILE = `export function unrelated() { return 1; }`;

describe('agent-session progress census wiring (fixture controls)', () => {
  it('accepts a correctly wired routine', () => {
    const v = judgeWiring(wired());
    expect(v).toStrictEqual({
      registered: true,
      importsCensus: true,
      callsReporter: true,
      ownWatermark: true,
    });
  });

  it('rejects a routine whose call site was deleted', () => {
    expect(judgeWiring(UNWIRED).callsReporter).toBe(false);
    expect(judgeWiring(UNWIRED).ownWatermark).toBe(false);
  });

  it('rejects a reporter that is declared but never called', () => {
    // The bare identifier is still present — this is why the judge matches the
    // call form, and the case that a naive `includes('reportAgentSessionProgress')`
    // would wave through.
    expect(DECLARED_BUT_NEVER_CALLED).toContain('reportAgentSessionProgress');
    expect(judgeWiring(DECLARED_BUT_NEVER_CALLED).callsReporter).toBe(false);
  });

  it('rejects a file that is not the reconcile routine at all', () => {
    expect(judgeWiring(WRONG_FILE).registered).toBe(false);
  });

  it('rejects a call that is not awaited inside the interval gate', () => {
    // Fire-and-forget would let a rejection escape the reconcile's own error path.
    expect(judgeWiring(wired({ call: 'reportAgentSessionProgress(ctx);' })).callsReporter).toBe(
      false,
    );
  });
});

describe('agent-session progress census wiring (live source)', () => {
  const source = readFileSync(ACTION, 'utf8');
  const verdict = judgeWiring(source);

  it('is reading the reconcile routine (positive control)', () => {
    expect(verdict.registered).toBe(true);
  });

  it('imports the census module', () => {
    expect(verdict.importsCensus).toBe(true);
  });

  it('still calls the reporter from the routine', () => {
    expect(verdict.callsReporter).toBe(true);
  });

  it('gates the reporter on its own hourly watermark', () => {
    expect(verdict.ownWatermark).toBe(true);
  });
});
