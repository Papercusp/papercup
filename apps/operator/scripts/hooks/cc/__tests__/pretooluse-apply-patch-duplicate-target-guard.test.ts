/**
 * pretooluse-apply-patch-duplicate-target-guard — recurrence guard for the
 * apply_patch DUPLICATE-TARGET class (P-010,
 * fleet-friction-remediation-2026-08-21).
 *
 * THE POINT OF THIS FILE: an apply_patch envelope permits at most one operation
 * per target path. Two `*** Update File:` blocks for one file are rejected
 * wholesale, deterministically, and the class has been filed independently at
 * least five times (EI-21353344120350526, EI-21354846297369687,
 * EI-21565696681975825, EI-21573638140720842, EI-22346861820470210). The last
 * names the gap this guard closes: the validation is deterministic "but was not
 * surfaced before submission".
 *
 * THE NEGATIVE CASES ARE THE LOAD-BEARING ONES. Editing several different files
 * in one patch, and editing one file through several `@@` hunks, are both the
 * NORMAL shape of a good patch — and the second IS the fix this guard tells
 * authors to apply. A guard that denied either would be routed around within a
 * day, which is how a working detector stops working. The documentation case
 * matters for the same reason: this repo contains prose ABOUT apply_patch, so a
 * patch adding `+*** Update File: x` as CONTENT must sail through.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Overridable so scripts/mutation-probe.sh can point this suite at a mutated
// COPY outside the tree (tier 2) — proving the guard is falsifiable without ever
// mutating the shared checkout, where a git-sync sweep could commit the mutant.
const HOOK = process.env.PROBE_HOOK
  ? resolve(process.env.PROBE_HOOK)
  : resolve(__dirname, '../pretooluse-apply-patch-duplicate-target-guard.mjs');

type Decision = { permissionDecision?: string; permissionDecisionReason?: string };

/** Drive the hook exactly as the CLI does: hook JSON on stdin, JSON or nothing out. */
function runHook(payload: unknown): Decision | null {
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!out.trim()) return null;
  return JSON.parse(out).hookSpecificOutput as Decision;
}

const patchCall = (patch: string) => ({ tool_name: 'apply_patch', tool_input: { input: patch } });

describe('pretooluse-apply-patch-duplicate-target-guard', () => {
  it('denies two Update File blocks for one path, split by a third file (EI-22346861820470210)', () => {
    // The exact reported shape: the collision is NOT adjacent in the source,
    // which is why authors do not spot it before submitting.
    const decision = runHook(
      patchCall(
        [
          '*** Begin Patch',
          '*** Update File: packages/operator-core/lib/frozen-candidate-repair-queue.ts',
          '@@ class RepairQueue',
          '-  const a = 1;',
          '+  const a = 2;',
          '*** Update File: packages/operator-core/lib/frozen-candidate-repair-queue.test.ts',
          '@@ describe',
          '-  expect(a).toBe(1);',
          '+  expect(a).toBe(2);',
          '*** Update File: packages/operator-core/lib/frozen-candidate-repair-queue.ts',
          '@@ function retire',
          '-  return null;',
          '+  return queue;',
          '*** End Patch',
        ].join('\n'),
      ),
    );

    expect(decision?.permissionDecision).toBe('deny');
    expect(decision?.permissionDecisionReason).toContain('frozen-candidate-repair-queue.ts');
    // The actionable merge hint EI-21353344120350526 asked for.
    expect(decision?.permissionDecisionReason).toMatch(/SINGLE|merge/i);
    expect(decision?.permissionDecisionReason).toContain('@@');
    // The test file is touched exactly once and must not be blamed.
    expect(decision?.permissionDecisionReason).not.toContain(
      'frozen-candidate-repair-queue.test.ts —',
    );
  });

  it('denies an Update and a Delete that target the same path', () => {
    const decision = runHook(
      patchCall(
        [
          '*** Begin Patch',
          '*** Update File: src/a.ts',
          '@@ x',
          '+const x = 1;',
          '*** Delete File: src/a.ts',
          '*** End Patch',
        ].join('\n'),
      ),
    );
    expect(decision?.permissionDecision).toBe('deny');
    expect(decision?.permissionDecisionReason).toContain('src/a.ts');
  });

  it('recognises ./x and x as the same target', () => {
    const decision = runHook(
      patchCall(
        [
          '*** Begin Patch',
          '*** Update File: ./src/a.ts',
          '@@ x',
          '+const x = 1;',
          '*** Update File: src/a.ts',
          '@@ y',
          '+const y = 2;',
          '*** End Patch',
        ].join('\n'),
      ),
    );
    expect(decision?.permissionDecision).toBe('deny');
  });

  // ── negatives: valid patches must remain accepted ────────────────────────

  it('allows one file edited through MULTIPLE @@ hunks (this is the prescribed fix)', () => {
    expect(
      runHook(
        patchCall(
          [
            '*** Begin Patch',
            '*** Update File: src/a.ts',
            '@@ first region',
            '-  const a = 1;',
            '+  const a = 2;',
            '@@ second region',
            '-  return null;',
            '+  return a;',
            '*** End Patch',
          ].join('\n'),
        ),
      ),
    ).toBeNull();
  });

  it('allows several DIFFERENT files in one patch', () => {
    expect(
      runHook(
        patchCall(
          [
            '*** Begin Patch',
            '*** Update File: src/a.ts',
            '@@ x',
            '+const x = 1;',
            '*** Add File: src/b.ts',
            '+export const b = 2;',
            '*** Delete File: src/c.ts',
            '*** End Patch',
          ].join('\n'),
        ),
      ),
    ).toBeNull();
  });

  it('allows a patch whose CONTENT documents apply_patch headers', () => {
    // Content lines are prefixed; only column-0 `*** ` is an operation header.
    // This repo really does ship prose about apply_patch, so this must pass.
    expect(
      runHook(
        patchCall(
          [
            '*** Begin Patch',
            '*** Update File: docs/codex.md',
            '@@ guidance',
            '+Do not write two blocks for one file:',
            '+*** Update File: src/a.ts',
            '+*** Update File: src/a.ts',
            '*** End Patch',
          ].join('\n'),
        ),
      ),
    ).toBeNull();
  });

  it('allows a rename (Update + Move to) — one operation, not two', () => {
    expect(
      runHook(
        patchCall(
          [
            '*** Begin Patch',
            '*** Update File: src/old.ts',
            '*** Move to: src/new.ts',
            '@@ x',
            '+const x = 1;',
            '*** End Patch',
          ].join('\n'),
        ),
      ),
    ).toBeNull();
  });

  it('ignores non-apply_patch tools, which cannot express a duplicate target', () => {
    expect(
      runHook({ tool_name: 'Write', tool_input: { file_path: 'src/a.ts', content: 'x' } }),
    ).toBeNull();
  });

  // ── fail-open: a bug here must never wedge every edit on the box ─────────

  it('fails open on an unparseable or empty payload', () => {
    for (const input of ['', 'not json', '{}']) {
      const out = execFileSync('node', [HOOK], {
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(out.trim()).toBe('');
    }
  });

  it('fails open when apply_patch carries no recognisable patch frame', () => {
    expect(runHook({ tool_name: 'apply_patch', tool_input: { input: 'no frame here' } })).toBeNull();
  });
});
