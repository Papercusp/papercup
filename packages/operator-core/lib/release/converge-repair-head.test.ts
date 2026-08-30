import { describe, expect, it } from 'vitest';
import {
  containmentForPaths,
  planConvergeRepairHead,
  realGitProbe,
  type GitProbe,
} from './converge-repair-head';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const queueAt = (repairHead: string) => ({ repairHead, worktreePath: '/tmp/repair-wt' });

describe('planConvergeRepairHead — the six verdicts of the sanctioned route (P-002/D-002)', () => {
  it('no frozen queue: an ordinary staging commit is already the judged lineage', () => {
    const plan = planConvergeRepairHead({
      queue: null,
      stagingTip: A,
      repairHeadIsAncestorOfStaging: null,
    });
    expect(plan.verdict).toBe('no-frozen-queue');
    expect(plan.newRepairHead).toBeNull();
    expect(plan.judgedSha).toBe(A);
  });

  it('D-002 case 1: an ancestor repairHead behind the tip fast-forwards', () => {
    const plan = planConvergeRepairHead({
      queue: queueAt(A),
      stagingTip: B,
      repairHeadIsAncestorOfStaging: true,
    });
    expect(plan.verdict).toBe('would-converge');
    expect(plan.newRepairHead).toBe(B);
    // The judged sha after applying the plan is the tip, which is what carries the fix.
    expect(plan.judgedSha).toBe(B);
    expect(plan.nextAction).toBeNull();
  });

  it('already at the tip: reported as converged, and proposes no move', () => {
    const plan = planConvergeRepairHead({
      queue: queueAt(A),
      stagingTip: A,
      repairHeadIsAncestorOfStaging: true,
    });
    expect(plan.verdict).toBe('already-converged');
    expect(plan.newRepairHead).toBeNull();
    expect(plan.judgedSha).toBe(A);
  });

  it('D-002 case 2: a diverged repairHead is NEVER fast-forwarded — it names the merge instead', () => {
    const plan = planConvergeRepairHead({
      queue: queueAt(C),
      stagingTip: B,
      repairHeadIsAncestorOfStaging: false,
    });
    expect(plan.verdict).toBe('diverged-merge-required');
    // The critical property: a fixer's unique commit must not be discarded.
    expect(plan.newRepairHead).toBeNull();
    expect(plan.judgedSha).toBe(C);
    expect(plan.nextAction).toContain('/tmp/repair-wt');
    // D-002 forbids the tempting wrong move, so the guidance must say so explicitly.
    expect(plan.nextAction).toContain('Do NOT re-cut a fresh candidate');
  });

  it('fails CLOSED when the ancestry probe is inconclusive, rather than guessing', () => {
    const plan = planConvergeRepairHead({
      queue: queueAt(A),
      stagingTip: B,
      repairHeadIsAncestorOfStaging: null,
    });
    expect(plan.verdict).toBe('ancestry-unverifiable');
    expect(plan.newRepairHead).toBeNull();
    // Fail-closed means the judged sha stays exactly what it is today.
    expect(plan.judgedSha).toBe(A);
  });

  it('fails closed when staging itself does not resolve', () => {
    const plan = planConvergeRepairHead({
      queue: queueAt(A),
      stagingTip: null,
      repairHeadIsAncestorOfStaging: true,
    });
    expect(plan.verdict).toBe('ancestry-unverifiable');
    expect(plan.newRepairHead).toBeNull();
  });

  it('never proposes a move that is not the staging tip', () => {
    for (const ancestor of [true, false, null]) {
      const plan = planConvergeRepairHead({
        queue: queueAt(A),
        stagingTip: B,
        repairHeadIsAncestorOfStaging: ancestor,
      });
      if (plan.newRepairHead !== null) expect(plan.newRepairHead).toBe(B);
    }
  });
});

describe('containmentForPaths — the completion evidence P-006 requires', () => {
  const probe = (blobs: Record<string, Record<string, string | null>>): GitProbe => ({
    revParse: () => null,
    isAncestor: () => null,
    blobAt: (_root, ref, path) => blobs[ref]?.[path] ?? null,
  });

  it('equal blobs mean the judged sha carries staging content', () => {
    const git = probe({ [A]: { 'x.ts': 'blob1' }, staging: { 'x.ts': 'blob1' } });
    const [row] = containmentForPaths(['x.ts'], A, '/repo', git, 'staging');
    expect(row.containedInJudgedSha).toBe(true);
  });

  it('different blobs mean the fix is NOT on the judged sha', () => {
    const git = probe({ [A]: { 'x.ts': 'old' }, staging: { 'x.ts': 'fixed' } });
    const [row] = containmentForPaths(['x.ts'], A, '/repo', git, 'staging');
    expect(row.containedInJudgedSha).toBe(false);
    expect(row.judgedBlob).toBe('old');
    expect(row.stagingBlob).toBe('fixed');
  });

  it('a path absent from BOTH refs is not contained — two nulls must not read as equal', () => {
    // The trap this pins: `null === null` would report a file that exists nowhere as
    // "contained", turning a missing fix into positive completion evidence.
    const git = probe({ [A]: {}, staging: {} });
    const [row] = containmentForPaths(['gone.ts'], A, '/repo', git, 'staging');
    expect(row.containedInJudgedSha).toBe(false);
  });

  it('reports every requested path, in order', () => {
    const git = probe({ [A]: { 'a.ts': '1' }, staging: { 'a.ts': '1', 'b.ts': '2' } });
    const rows = containmentForPaths(['a.ts', 'b.ts'], A, '/repo', git, 'staging');
    expect(rows.map((r) => r.path)).toEqual(['a.ts', 'b.ts']);
    expect(rows.map((r) => r.containedInJudgedSha)).toEqual([true, false]);
  });
});

describe('realGitProbe — the documented rev-parse footgun must not reach callers', () => {
  const root = process.cwd();

  it('returns null (never the echoed ref string) for a path absent from the ref', () => {
    // A bare `git rev-parse <ref>:<missing>` PRINTS "<ref>:<missing>" to stdout before
    // exiting 128. Without --verify --quiet + a sha shape check, that string is captured
    // as though it were a blob sha, and the containment comparison silently goes wrong.
    const absent = realGitProbe.blobAt(root, 'HEAD', 'definitely/not/a/real/path-xyz.ts');
    expect(absent).toBeNull();
  });

  it('resolves a real path at HEAD to a sha-shaped value (positive control)', () => {
    const present = realGitProbe.blobAt(root, 'HEAD', 'package.json');
    expect(present).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it('reports an unresolvable ref as null rather than a guess', () => {
    expect(realGitProbe.revParse(root, 'no-such-ref-xyz')).toBeNull();
  });

  it('HEAD resolves (positive control for the same instrument)', () => {
    expect(realGitProbe.revParse(root, 'HEAD')).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it('isAncestor answers true for HEAD vs itself, and null for a bogus object', () => {
    const head = realGitProbe.revParse(root, 'HEAD');
    expect(head).not.toBeNull();
    expect(realGitProbe.isAncestor(root, head as string, head as string)).toBe(true);
    // A bad object must be UNKNOWN (null), not false — false would read as "diverged"
    // and route the caller to a merge that is not needed.
    expect(realGitProbe.isAncestor(root, 'f'.repeat(40), head as string)).toBeNull();
  });
});
