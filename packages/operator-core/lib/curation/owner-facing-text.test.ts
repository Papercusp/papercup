import { describe, it, expect } from 'vitest';
import { projectOwnerFacing, shortAgentHandle } from './owner-facing-text';
import { formatSignalLine, signalToReportItem } from './curation-loop';
import type { ClassifiedSignal } from './salience-policy';

/**
 * WI-37946 — owner-facing identifier projection.
 *
 * Every fixture marked LIVE is a VERBATIM row measured off the rendered feed on
 * the running rig (2026-08-11, desktop pid 191771, `span.report-block-item-text`).
 * Using the real strings rather than invented ones is the point: the projection
 * is only worth anything if it survives the prose producers actually emit.
 */

describe('projectOwnerFacing', () => {
  describe('agent UUIDs', () => {
    it('LIVE: collapses a short handle followed by its own full UUID', () => {
      const live =
        'Blocked — fleet member su · su-90cc5 (su-90cc5cbd-6f87-49b6-a475-71c31cc08341) died on "Prompt is too long" — context overflowed its model window; it cannot take another turn';
      const out = projectOwnerFacing(live);
      expect(out).toBe(
        'Blocked — fleet member su · su-90cc5 died on "Prompt is too long" — context overflowed its model window; it cannot take another turn',
      );
      expect(out).not.toMatch(/su-[0-9a-f]{8}-[0-9a-f]{4}/);
    });

    it('LIVE: shortens a bare UUID with no short handle beside it', () => {
      const live =
        'Blocked [papercusp] — mintRecycleArgs copies the launch KICKOFF POSITIONAL through verbatim · held by ended session su-12b70e95-84ce-4ea0-b546-8a692cdc949c';
      const out = projectOwnerFacing(live);
      expect(out).toContain('held by ended session su-12b70');
      expect(out).not.toMatch(/su-[0-9a-f]{8}-[0-9a-f]{4}/);
    });

    it('keeps two DIFFERENT agents distinguishable rather than collapsing them', () => {
      const out = projectOwnerFacing(
        'su-90cc5cbd-6f87-49b6-a475-71c31cc08341 handed off to su-04c552b7-09e5-498b-b2da-c80b2cfb79b0',
      );
      expect(out).toBe('su-90cc5 handed off to su-04c55');
    });
  });

  describe('system actor attribution', () => {
    it('LIVE: strips the (system:*) actor from the plan-lane-sync suffix', () => {
      const live =
        'Blocked [papercusp] — Constellations site P-004 SERVE: supervised systemd --user unit serving site/ on a fixed port, with restart evidence · plan lane constellations-88-reference-site-2026-08-11#P-004 is blocked — linked work-item parked until the lane clears (system:plan-item-lane-sync)';
      const out = projectOwnerFacing(live);
      expect(out).not.toContain('system:plan-item-lane-sync');
      expect(out).toMatch(/linked work-item parked until the lane clears$/);
    });
  });

  describe('source paths', () => {
    it('LIVE: reduces a repo-relative source path to its basename', () => {
      const live =
        'Done [papercusp] — Test failing repeatedly: packages/operator-core/lib/harness/git-sync/git-sync-checkpoint-resume.test.ts';
      expect(projectOwnerFacing(live)).toBe(
        'Done [papercusp] — Test failing repeatedly: git-sync-checkpoint-resume.test.ts',
      );
    });

    it('handles a path with no intermediate directory', () => {
      expect(projectOwnerFacing('see scripts/affected-tests.mjs')).toBe('see affected-tests.mjs');
    });
  });

  describe('what it deliberately preserves', () => {
    // These are SCOPE DECISIONS recorded on WI-37946, not omissions. A future
    // change that starts stripping them should have to delete a passing test.
    it('LIVE: preserves WI-/EI- ids, which are load-bearing inside the sentence', () => {
      const live =
        'Cleared — Reproduce and root-cause EI-20185455308799001, the transient six-unaccounted-cgroup alert';
      expect(projectOwnerFacing(live)).toBe(live);
    });

    it('LIVE: preserves plan slugs', () => {
      const live = 'Progress — template-supply-chain-repair-2026-08-10 P-006: todo → done';
      expect(projectOwnerFacing(live)).toBe(live);
    });

    it('preserves ordinary prose untouched', () => {
      const plain = 'Blocked [papercusp] — the release gate is red and nobody is on it';
      expect(projectOwnerFacing(plain)).toBe(plain);
    });
  });

  describe('robustness', () => {
    it('is idempotent — projecting twice equals projecting once', () => {
      const live =
        'Blocked — su · su-90cc5 (su-90cc5cbd-6f87-49b6-a475-71c31cc08341) · packages/operator-core/lib/curation/curation-loop.ts (system:plan-item-lane-sync)';
      const once = projectOwnerFacing(live);
      expect(projectOwnerFacing(once)).toBe(once);
    });

    it('tolerates empty input', () => {
      expect(projectOwnerFacing('')).toBe('');
    });
  });

  it('shortAgentHandle matches the su-XXXXX display convention', () => {
    expect(shortAgentHandle('su-90cc5cbd-6f87-49b6-a475-71c31cc08341')).toBe('su-90cc5');
  });
});

describe('the projection is applied at the shared render seam', () => {
  const signal = (over: Partial<ClassifiedSignal['signal']> = {}): ClassifiedSignal =>
    ({
      signal: {
        id: 'blocked:WI-1',
        kind: 'blocker',
        title: 'held by ended session su-12b70e95-84ce-4ea0-b546-8a692cdc949c',
        harness: 'papercusp',
        ref: 'wi:WI-1',
        ts: new Date().toISOString(),
        ...over,
      },
    }) as ClassifiedSignal;

  it('formatSignalLine (text rendition) is projected', () => {
    expect(formatSignalLine(signal())).not.toMatch(/su-[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('signalToReportItem (card rendition) is projected — the two cannot drift', () => {
    expect(signalToReportItem(signal()).text).not.toMatch(/su-[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('the drill-in ref is NOT projected — the raw id stays reachable (D-005)', () => {
    const item = signalToReportItem(
      signal({ ref: 'escalation:su-12b70e95-84ce-4ea0-b546-8a692cdc949c' }),
    );
    expect(item.ref).toBe('escalation:su-12b70e95-84ce-4ea0-b546-8a692cdc949c');
  });
});
