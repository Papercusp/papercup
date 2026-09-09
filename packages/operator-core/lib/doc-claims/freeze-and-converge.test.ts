/**
 * CLAUDE.md's freeze-and-converge claims must stay true of the queue's own module
 * (frozen-candidate-compliance-enforcement-2026-08-30 P-009; sibling of
 * `gate-candidate-ref.test.ts`, same doc-claims family).
 *
 * The FIXTURE controls are load-bearing for the reason the siblings state: once the live
 * assertion goes green it stops being evidence that the detector works at all. The first
 * fixture reproduces the exact design that was proposed on this plan and retracted —
 * fast-forwarding the frozen candidate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeFreezeAndConverge, stripComments } from './freeze-and-converge';
import { readCorpus } from './corpus-subject';
// The hook is plain-Node .mjs with a hand-kept .d.mts beside it (P-019 parity test imports it the same way).
import { warningFor } from '../../../../apps/operator/scripts/hooks/cc/posttooluse-frozen-candidate-edit-nudge.mjs';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
// P-012 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03): the ROUTE the prose
// prescribes — author on staging, then admit BY PATH — and its two in-code counterparts: the
// edit hook that prints the command, and the door that refuses an incomplete admission.
const HOOK = join(ROOT, 'apps/operator/scripts/hooks/cc/posttooluse-frozen-candidate-edit-nudge.mjs');
const DOOR = join(ROOT, 'packages/operator-core/lib/agent-tools/release/repair-queue.ts');
const FROZEN_HEADING = '⛔ **A RED CANDIDATE IS FROZEN ON PURPOSE';

/** The frozen-candidate section of the corpus: from its heading to the next section or the freeze-read box. */
function frozenSection(text: string): string {
  const start = text.indexOf(FROZEN_HEADING);
  if (start < 0) return '';
  const rest = text.slice(start);
  const end = rest.search(/\n## |\n✅ \*\*"Is the freeze ON/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/**
 * What the route prose must say, and what it must never say again. Each REQUIRED clause names
 * a mechanism that exists in code (checked below); each FORBIDDEN one is a retired route that
 * an agent would follow straight into the treadmill the freeze exists to stop.
 */
function routeViolations(body: string): string[] {
  const required: Array<[string, RegExp]> = [
    ['author on the shared staging checkout', /author the fix on the shared staging checkout/],
    ['no repair worktree (D-010)', /NO\s+repair worktree/],
    ['the admit door, by path', /release:repair-queue \{ op:\s*'admit', paths:/],
    ['repairHead is what advances', /advancing `repairHead`/],
    ['hunk-exact admission (D-008)', /hunk-exact/],
    ['completeness refusal (P-004)', /`admission-incomplete`/],
    ['the tip is never widened', /tip is NEVER widened/],
  ];
  const forbidden: Array<[string, RegExp]> = [
    ['a converge-to-tip route', /converge (?:repairHead )?(?:to|with|onto) (?:the )?(?:staging )?tip/i],
    ['fixing in the repair worktree', /(?:fix|author|edit)[^.]{0,40}\bin the repair worktree/i],
    ['the retired converge op', /op:\s*'converge'/],
  ];
  return [
    ...required.filter(([, re]) => !re.test(body)).map(([label]) => `missing: ${label}`),
    ...forbidden.filter(([, re]) => re.test(body)).map(([label]) => `forbidden: ${label}`),
  ];
}
const QUEUE = join(ROOT, 'packages/operator-core/lib/release/frozen-candidate-repair-queue.ts');
const CHECKPOINT_RUN = join(ROOT, 'packages/operator-core/lib/agent-tools/release/checkpoint-run.ts');
// P-001 / D-010 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03): the ONE door a
// fix enters the frozen lineage through. `converge-repair-head.ts` (the fast-forward plan) is
// gone; what remains of it is the read-only containment probe in `judged-sha-containment.ts`.
const ADMIT = join(ROOT, 'packages/operator-core/lib/release/repair-head-admission.ts');

describe('fixture controls (the detector must be able to FAIL)', () => {
  it('catches a fast-forward of the frozen candidate — the retracted design', () => {
    const verdict = judgeFreezeAndConverge(`
      const advanced = { ...queue, candidate: stagingTip, repairHead: stagingTip };
    `);
    expect(verdict.ok).toBe(false);
    expect(verdict.candidateWriteSites).toHaveLength(1);
    expect(verdict.violations.join('\n')).toMatch(/does not move/);
  });

  it('catches the mechanism going missing entirely', () => {
    const verdict = judgeFreezeAndConverge('const x = 1;');
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join('\n')).toMatch(/mechanism the prose describes is absent/);
  });

  it('accepts the correct shape: repairHead moves, candidate does not', () => {
    const verdict = judgeFreezeAndConverge(`
      const converged = { ...queue, repairHead: decision.newRepairHead };
    `);
    expect(verdict.ok).toBe(true);
  });

  it('does not count a doc comment as a candidate write', () => {
    const verdict = judgeFreezeAndConverge(`
      /** never do { ...queue, candidate: tip } — the candidate is immutable */
      const converged = { ...queue, repairHead: tip };
    `);
    expect(verdict.candidateWriteSites).toHaveLength(0);
    expect(verdict.ok).toBe(true);
  });

  it('stripComments removes block and line comments but keeps code', () => {
    expect(stripComments('/* a */ const x = 1; // b')).toContain('const x = 1;');
    expect(stripComments('/* a */ const x = 1; // b')).not.toContain('// b');
  });
});

describe('the live claim', () => {
  it('does not count a projection that spreads a queue IDENTITY and copies candidate through', () => {
    const verdict = judgeFreezeAndConverge(
      'return { ...identity, candidate: queue.candidate, repairHead: queue.repairHead };',
    );
    expect(verdict.candidateWriteSites).toHaveLength(0);
  });

  it('the queue module advances repairHead and never rewrites candidate', () => {
    const verdict = judgeFreezeAndConverge(readFileSync(QUEUE, 'utf8'));
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('the P-001 admit route (the one door) also leaves the candidate alone', () => {
    const verdict = judgeFreezeAndConverge(readFileSync(ADMIT, 'utf8'));
    expect(verdict.candidateWriteSites).toEqual([]);
  });

  it('the queue module still documents the candidate as immutable', () => {
    // The prose half of the pair: if this wording goes, CLAUDE.md's claim has lost its
    // in-code counterpart and the next reader has only the doc to trust.
    expect(readFileSync(QUEUE, 'utf8')).toMatch(/immutable/i);
  });

  it('the checkpoint-run guidance distinguishes frozen-queue resume from a no-queue quiet cut', () => {
    const section = frozenSection(readCorpus());
    const checkpointRun = readFileSync(CHECKPOINT_RUN, 'utf8');
    const queue = readFileSync(QUEUE, 'utf8');

    // A manual run is queue-aware now: claiming every run cuts at tip would send agents to the
    // old treadmill and contradict the exact candidate the detached writer is given.
    expect(section).toMatch(/when a frozen queue\s+exists, it applies the queue policy and resumes the exact frozen lineage/i);
    expect(section).toMatch(/`ready-to-test` uses\s+`queue\.candidate`; `ready-to-verify` uses\s+`queue\.repairHead`/);
    expect(section).toMatch(/Only when no frozen queue exists does it cut a fresh candidate from the current quiet\s+cut at tip/i);

    // Positive controls: the source files named by the prose implement both halves.
    expect(checkpointRun).toMatch(/assessFrozenRepairQueuePreflight/);
    expect(checkpointRun).toMatch(/candidateSource/);
    expect(queue).toMatch(/queue\.phase === 'ready-to-verify'/);
    expect(queue).toMatch(/candidate: queue\.repairHead/);
  });
});

describe('P-012: the route prose is "author on staging, then admit BY PATH" — pinned to the hook and the door', () => {
  describe('fixture controls', () => {
    it('fires on the pre-D-010 wording that never named the door', () => {
      const old =
        "So when the gate is red: **fix the frozen candidate's reds so the fixes land ON TOP of it** " +
        '(advancing `repairHead`) — the queue re-tests that sha itself.';
      expect(routeViolations(old)).toContain('missing: the admit door, by path');
    });
    it('fires on a converge-to-tip sentence and on "fix in the repair worktree", even beside the right command', () => {
      const bad =
        "author the fix on the shared staging checkout (or in the repair worktree), then converge repairHead to the staging tip: " +
        "`release:repair-queue { op: 'admit', paths: [...] }`";
      const v = routeViolations(bad);
      expect(v).toContain('forbidden: a converge-to-tip route');
      expect(v).toContain('forbidden: fixing in the repair worktree');
    });
  });

  it('the projected corpus carries the section and every required clause, and none of the retired routes', () => {
    const section = frozenSection(readCorpus());
    expect(section.length).toBeGreaterThan(200);
    expect(routeViolations(section)).toEqual([]);
  });

  it('the edit hook prints the admit command the prose promises — never converge, never a worktree', () => {
    const marker = {
      candidate: 'a'.repeat(40),
      repairHead: 'b'.repeat(40),
      phase: 'awaiting-fixer',
      failingPaths: ['packages/x/lib/a.test.ts'],
      legs: [],
    };
    const msg = warningFor(marker, 'packages/x/lib/a.test.ts') ?? '';
    expect(msg).toMatch(/release:repair-queue \{ op:\s*'admit', paths:/);
    expect(msg).not.toMatch(/converge|worktree/i);
    expect(warningFor(marker, 'packages/x/lib/other.ts')).toBeNull();
    // and the file the prose points at is the one that prints it
    expect(readFileSync(HOOK, 'utf8')).toMatch(/export function warningFor/);
  });

  it('the door refuses `admission-incomplete` and says there is no repair worktree — the prose names real mechanisms', () => {
    const door = readFileSync(DOOR, 'utf8');
    expect(door).toMatch(/admission-incomplete/);
    expect(door).toMatch(/there is no repair worktree/i);
    expect(readFileSync(ADMIT, 'utf8')).toMatch(/'admission-incomplete'/);
  });
});
