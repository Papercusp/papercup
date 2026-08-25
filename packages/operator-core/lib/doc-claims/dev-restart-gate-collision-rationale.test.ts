/**
 * EI-21437097591910648 / EI-20286473216066539 — dev:restart's gate-collision prose
 * must not resurrect a mechanism its own check disproves.
 *
 * HISTORY THIS PINS. EI-20286473216066539 established BY MEASUREMENT (2026-08-12)
 * that a bg-host restart cannot abort an in-flight green-checkpoint run: the suite
 * runs detached in its own transient unit, outside the target's cgroup, and
 * `systemctl restart` kills by cgroup. The fix landed in the COLLISION CHECK
 * (gate-collision-guard.ts returns blocked:false / kind:'run-in-flight-isolated')
 * but NOT in the prose: `override_gate_collision`'s describe() went on asserting
 * "a restart mid-run can starve the gate into a FALSE red" for another 12 days.
 *
 * WHY THAT DESERVES A GUARD RATHER THAN A CAREFUL EDIT. A tool's describe() text is
 * loaded into the context of every agent that touches the tool, BEFORE they ever call
 * it — so a refuted claim there outruns its own fix, and it is strictly SCARIER than
 * the truth, which is the direction agents preferentially preserve across compaction.
 * Measured cost: at least three independent sessions carried the false premise, one
 * escalating it to the owner as a hard blocker. A prior attempt to patch this text
 * (2026-08-13) silently did not apply, and nothing detected that for 12 days.
 *
 * FAILS ON DRIFT, NOT ON THE CURRENT ANSWER. If the gate legitimately starts blocking
 * an isolated run, the code pin below fails in the SAME change — forcing the prose and
 * the check to be corrected together instead of drifting apart again.
 *
 * ABSENCE ASSERTIONS ARE PAIRED WITH POSITIVE CONTROLS over the same bytes (the
 * discipline of gate-resilience-rejected-mechanisms.test.ts): a broken instrument —
 * a moved file, a renamed anchor, an empty read — is otherwise indistinguishable from
 * a genuine absence, and would report this guard as passing while measuring nothing.
 *
 * FALSIFIABILITY. The subject path is overridable so the pre-fix source can be replayed
 * from git history WITHOUT mutating the shared tree:
 *   scripts/mutation-probe.sh \
 *     --file packages/operator-core/lib/agent-tools/dev/restart.ts \
 *     --against-last-without 'SURVIVES a restart' \
 *     --positive-control 'override_gate_collision' \
 *     --calibration "grep -q 'override_gate_collision' {}" \
 *     --test 'DOC_CLAIM_RESTART_PATH={} npm run test:file -- packages/operator-core/lib/doc-claims/dev-restart-gate-collision-rationale.test.ts'
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const RESTART_TOOL = process.env.DOC_CLAIM_RESTART_PATH
  ? resolve(process.env.DOC_CLAIM_RESTART_PATH)
  : join(ROOT, 'packages/operator-core/lib/agent-tools/dev/restart.ts');

const COLLISION_GUARD = join(ROOT, 'packages/operator-core/lib/release/gate-collision-guard.ts');

/**
 * The `override_gate_collision` describe() text, sliced between two stable anchors.
 * Slicing (rather than scanning the whole file) keeps the assertion pointed at the
 * agent-facing prose and off the internal comments, which may legitimately narrate
 * the refuted mechanism as history.
 */
function overrideGateCollisionProse(): string {
  const source = readFileSync(RESTART_TOOL, 'utf8');
  const start = source.indexOf('override_gate_collision');
  const end = source.indexOf('override_boot_integrity', start + 1);
  expect(start, 'anchor `override_gate_collision` not found — instrument is broken').toBeGreaterThan(-1);
  expect(end, 'anchor `override_boot_integrity` not found — instrument is broken').toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('dev:restart override_gate_collision prose does not assert the refuted starvation mechanism', () => {
  // Any spelling of "restarting can wreck the in-flight run".
  const REFUTED =
    /starv\w*\s+(the\s+)?gate|starv\w*\s+.{0,30}FALSE\s+red|restart\s+.{0,40}(abort|terminate|kill)\w*\s+.{0,20}run|(abort|kill)\w*\s+an?\s+in-flight\s+(green-checkpoint\s+)?run/i;

  it('positive control — the describe() prose is present and substantial (instrument reads real bytes)', () => {
    const prose = overrideGateCollisionProse();
    // If this control fails, the absence assertion below is measuring nothing.
    expect(prose).toContain('gate-sensitive target');
    expect(prose.length).toBeGreaterThan(120);
  });

  it('no refuted starvation/abort mechanism survives in the agent-facing description', () => {
    const prose = overrideGateCollisionProse();
    const hits = prose
      .split('\n')
      .flatMap((text, i) => (REFUTED.test(text) ? [`${i + 1}: ${text.trim()}`] : []));
    expect(
      hits,
      'dev:restart override_gate_collision re-asserts a mechanism EI-20286473216066539 disproved ' +
        `by measurement (a restart cannot abort a cgroup-isolated run):\n${hits.join('\n')}`,
    ).toEqual([]);
  });

  it('negative control — the guard would catch the pre-fix wording', () => {
    // Proves the matcher is live rather than vacuously passing: the exact historical
    // sentence must be recognised as refuted.
    const preFix =
      'Only pass when the target is genuinely wedged and cannot wait — a restart mid-run ' +
      'can starve the gate into a FALSE red that gets misdiagnosed as a regression.';
    expect(REFUTED.test(preFix)).toBe(true);
  });
});

describe('the collision check still treats a cgroup-isolated run as non-blocking (the code the prose describes)', () => {
  it('gate-collision-guard.ts returns a non-blocking verdict for an isolated in-flight run', () => {
    const source = readFileSync(COLLISION_GUARD, 'utf8');
    // Positive control + anchor: the isolated verdict exists at all.
    expect(source).toContain(`kind: 'run-in-flight-isolated'`);
    // The pin itself: that branch is reached via cgroupRelation === 'different'
    // and reports blocked:false. If the gate ever legitimately blocks here, this
    // fails in the same change and forces the prose above to be revisited.
    const branch = source.slice(
      source.indexOf(`cgroupRelation === 'different'`),
      source.indexOf(`kind: 'run-in-flight-isolated'`),
    );
    expect(branch).toContain('blocked: false');
  });
});
