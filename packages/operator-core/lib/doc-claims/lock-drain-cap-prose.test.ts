import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { judgeDrainCapProse, type DrainCapSubject } from './lock-drain-cap-prose';

/**
 * Repo root from this file: packages/operator-core/lib/doc-claims → up four.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

/** Subjects that really carry `max_drain_sec` guidance to agents. */
const SUBJECT_PATHS = [
  'apps/operator-docs/src/content/docs/agent-spawning/named-resource-locks.mdx',
  'libs/papercusp/packages/harness/blueprints/base/prompts/merge-resolver.md',
];

function readSubject(rel: string): DrainCapSubject {
  return { label: rel, text: readFileSync(join(REPO_ROOT, rel), 'utf8') };
}

/**
 * Pull a `const NAME = <int>;` out of a source file. Deliberately NOT an import:
 * importing would let a rename slide by as `undefined`, whereas a failed extraction
 * is reported as the constants having moved — which is itself the thing to know.
 */
function readIntConst(rel: string, name: string): number {
  const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
  const m = src.match(new RegExp(`\\b${name}\\s*=\\s*(\\d+)`));
  if (!m) {
    throw new Error(
      `${name} not found in ${rel}. The constant was renamed or moved; re-point this ` +
        `guard at its new home rather than deleting the assertion.`,
    );
  }
  return Number(m[1]);
}

const LOCK_WAIT_CAP = readIntConst(
  'packages/operator-core/lib/agent-tools/locks/lock-config.ts',
  'MAX_LOCK_WAIT_SEC',
);
const WRAPPER_DRAIN_CAP = readIntConst(
  'packages/operator-core/lib/agent-tools/dev/restart.ts',
  'MAX_DRAIN_SEC',
);

describe('max_drain_sec prose does not hand agents the wrong cap', () => {
  it('reads both live constants', () => {
    expect(Number.isInteger(LOCK_WAIT_CAP)).toBe(true);
    expect(Number.isInteger(WRAPPER_DRAIN_CAP)).toBe(true);
    expect(LOCK_WAIT_CAP).toBeGreaterThan(0);
    expect(WRAPPER_DRAIN_CAP).toBeGreaterThan(0);
  });

  it('db:migrate declares the same wrapper ceiling dev:restart does', () => {
    // If these ever diverge, the guard's two-population framing is no longer the
    // whole story and the prose it judges needs a third number.
    const migrateCap = readIntConst(
      'packages/operator-core/lib/agent-tools/db/migrate.ts',
      'MAX_DRAIN_SEC',
    );
    expect(migrateCap).toBe(WRAPPER_DRAIN_CAP);
  });

  it('every guarded subject is clean against the live constants', () => {
    const subjects = SUBJECT_PATHS.map(readSubject);
    const verdict = judgeDrainCapProse({
      subjects,
      lockWaitCapSec: LOCK_WAIT_CAP,
      wrapperMaxDrainSec: WRAPPER_DRAIN_CAP,
    });

    // Non-vacuity floor: a subject set that stopped discussing max_drain_sec is a
    // refusal, not a pass — otherwise a moved file reads as compliance.
    expect(verdict.measured).toBe(SUBJECT_PATHS.length);

    expect(
      verdict.violations,
      verdict.violations.map((v) => `${v.subject}:${v.line} — ${v.reason}`).join('\n'),
    ).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  // ── Falsifiability controls ────────────────────────────────────────────────
  // Kept permanently in-file as deliberately-wrong implementations, so proving this
  // guard CAN fail never requires mutating the shared working tree.

  it('CONTROL: catches the merge-resolver prompt bug it was written for', () => {
    const verdict = judgeDrainCapProse({
      subjects: [
        {
          label: 'control/merge-resolver.md',
          text:
            "1. **Take the lock.** `locks:acquire_resource { resource: 'git-sync', " +
            "mode: 'exclusive', wait: { max_drain_sec: 120 } }` so the next tick waits.",
        },
      ],
      lockWaitCapSec: 45,
      wrapperMaxDrainSec: 300,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.some((v) => v.reason.includes('REJECTED, not clamped'))).toBe(true);
  });

  it('CONTROL: catches the doc sentence that quoted only the wrapper cap', () => {
    const verdict = judgeDrainCapProse({
      subjects: [
        {
          label: 'control/named-resource-locks.mdx',
          text:
            'Bounds the tools enforce: the lease TTL defaults to 1200s and caps at ' +
            '3600s; `max_drain_sec` caps at **300s**. Use locks:acquire_resource for a ' +
            'named resource.',
        },
      ],
      lockWaitCapSec: 45,
      wrapperMaxDrainSec: 300,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.some((v) => v.reason.includes('wrapper ceiling'))).toBe(true);
  });

  it('CONTROL: reports a rotted warning once the caps converge', () => {
    const verdict = judgeDrainCapProse({
      subjects: [
        {
          label: 'control/converged.mdx',
          text:
            '`max_drain_sec` is ONE ARG NAME WITH TWO DIFFERENT CAPS — acquire_resource ' +
            'caps at 45s while the wrappers cap at 45s.',
        },
      ],
      lockWaitCapSec: 45,
      wrapperMaxDrainSec: 45,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.some((v) => v.reason.includes('rotted'))).toBe(true);
  });

  it('CALIBRATION: correct prose passes, so the controls above are not passing on a broken judge', () => {
    const verdict = judgeDrainCapProse({
      subjects: [
        {
          label: 'control/correct.mdx',
          text:
            '`locks:acquire_resource` caps `wait.max_drain_sec` at 45s and REJECTS an ' +
            'over-cap value. The 300s ceiling belongs to dev:restart / db:migrate, ' +
            'which take their own max_drain_sec.',
        },
      ],
      lockWaitCapSec: 45,
      wrapperMaxDrainSec: 300,
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.measured).toBe(1);
  });

  it('CALIBRATION: a subject with no max_drain_sec talk is not counted as measured', () => {
    const verdict = judgeDrainCapProse({
      subjects: [{ label: 'control/unrelated.md', text: 'Nothing about lock draining here.' }],
      lockWaitCapSec: 45,
      wrapperMaxDrainSec: 300,
    });
    expect(verdict.measured).toBe(0);
    expect(verdict.ok).toBe(true);
  });
});
