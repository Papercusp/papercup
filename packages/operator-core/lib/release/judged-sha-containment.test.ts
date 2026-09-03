import { describe, expect, it } from 'vitest';
import { containmentForPaths, realGitProbe, type GitProbe } from './judged-sha-containment';

const A = 'a'.repeat(40);

describe('containmentForPaths — the completion evidence a gate-red claim requires', () => {
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
    // A bad object must be UNKNOWN (null), not false.
    expect(realGitProbe.isAncestor(root, 'f'.repeat(40), head as string)).toBeNull();
  });
});
