import { describe, expect, it } from 'vitest';
import { detectFrozenCandidateDrift, parseDriftCommits } from './frozen-candidate-drift-sweep';
import type { FrozenRepairEditMarker } from './frozen-repair-edit-marker';

const marker: FrozenRepairEditMarker = {
  candidate: 'c'.repeat(40),
  repairHead: 'r'.repeat(40),
  phase: 'repair-in-progress',
  failingPaths: ['a/failing.test.ts', 'b/failing.test.ts'],
  updatedAtMs: 1,
  admittedPaths: [],
  legs: [],
};

describe('detectFrozenCandidateDrift (P-008) — the attestation leg', () => {
  it('detects the signature: a failing path changed above the frozen candidate', () => {
    const f = detectFrozenCandidateDrift({
      marker,
      commitsAboveCandidate: [{ sha: 'a'.repeat(40), agent: 'su-123', paths: ['a/failing.test.ts'] }],
    });
    expect(f).toBeDefined();
    expect(f?.paths.map((p) => p.path)).toEqual(['a/failing.test.ts']);
    expect(f?.agents).toEqual(['su-123']);
    expect(f?.title).toContain('frozen-candidate drift');
    expect(f?.body).toContain("op:'admit'");
  });

  it('is SILENT when no failing path drifted — the outcome this plan wants', () => {
    expect(
      detectFrozenCandidateDrift({
        marker,
        commitsAboveCandidate: [{ sha: 'a'.repeat(40), agent: 'su-123', paths: ['unrelated/x.ts'] }],
      }),
    ).toBeUndefined();
  });

  it('is silent when nothing is frozen — there is no "above the candidate" to drift into', () => {
    expect(
      detectFrozenCandidateDrift({
        marker: null,
        commitsAboveCandidate: [{ sha: 'a'.repeat(40), agent: 'su-1', paths: ['a/failing.test.ts'] }],
      }),
    ).toBeUndefined();
  });

  it('is silent when the failing set is empty rather than reporting a vacuous zero', () => {
    expect(
      detectFrozenCandidateDrift({
        marker: { ...marker, failingPaths: [] },
        commitsAboveCandidate: [{ sha: 'a'.repeat(40), agent: 'su-1', paths: ['a/failing.test.ts'] }],
      }),
    ).toBeUndefined();
  });

  it('groups several commits under one path and de-duplicates by sha', () => {
    const f = detectFrozenCandidateDrift({
      marker,
      commitsAboveCandidate: [
        { sha: 'a'.repeat(40), agent: 'su-1', paths: ['a/failing.test.ts', 'a/failing.test.ts'] },
        { sha: 'b'.repeat(40), agent: 'su-2', paths: ['a/failing.test.ts'] },
      ],
    });
    expect(f?.paths).toHaveLength(1);
    expect(f?.paths[0].commits).toHaveLength(2);
    expect(f?.agents).toEqual(['su-1', 'su-2']);
  });

  it('does NOT attribute a commit with no agent trailer — blame would name the wrong agent', () => {
    const f = detectFrozenCandidateDrift({
      marker,
      commitsAboveCandidate: [{ sha: 'a'.repeat(40), agent: null, paths: ['a/failing.test.ts'] }],
    });
    expect(f?.agents).toEqual([]);
    expect(f?.unattributedCommits).toBe(1);
    expect(f?.body).toContain('unattributed');
    expect(f?.body).toContain('none of this is attributable');
  });

  it('normalizes paths before matching the failing set', () => {
    const f = detectFrozenCandidateDrift({
      marker,
      commitsAboveCandidate: [{ sha: 'a'.repeat(40), agent: 'su-1', paths: ['./a/failing.test.ts'] }],
    });
    expect(f?.paths.map((p) => p.path)).toEqual(['a/failing.test.ts']);
  });

  it('sorts paths so the finding body is stable across runs', () => {
    const f = detectFrozenCandidateDrift({
      marker,
      commitsAboveCandidate: [
        { sha: 'a'.repeat(40), agent: 'su-1', paths: ['b/failing.test.ts'] },
        { sha: 'b'.repeat(40), agent: 'su-1', paths: ['a/failing.test.ts'] },
      ],
    });
    expect(f?.paths.map((p) => p.path)).toEqual(['a/failing.test.ts', 'b/failing.test.ts']);
  });
});

describe('parseDriftCommits', () => {
  const block = (sha: string, agent: string | null, paths: string[]) =>
    [sha, ...(agent ? [`Papercusp-Agent: ${agent}`] : []), ...paths].join('\n');

  it('parses NUL-separated commit blocks with trailer and paths', () => {
    const raw = [
      block('a'.repeat(40), 'su-1', ['a/failing.test.ts', 'x.ts']),
      block('b'.repeat(40), null, ['b/failing.test.ts']),
    ].join('\x00');
    const commits = parseDriftCommits(raw);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      sha: 'a'.repeat(40),
      agent: 'su-1',
      paths: ['a/failing.test.ts', 'x.ts'],
    });
    expect(commits[1].agent).toBeNull();
  });

  it('skips blocks whose first line is not a sha rather than inventing a commit', () => {
    expect(parseDriftCommits('not-a-sha\nfoo.ts')).toEqual([]);
  });

  it('returns nothing for empty input', () => {
    expect(parseDriftCommits('')).toEqual([]);
    expect(parseDriftCommits('\x00\x00')).toEqual([]);
  });
});
