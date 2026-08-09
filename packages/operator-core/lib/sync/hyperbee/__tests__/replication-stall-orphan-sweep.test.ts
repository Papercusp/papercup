/**
 * replication-stall-orphan-sweep.test.ts — the orphan-sweep escalator patch.
 *
 * Covers: target parsing off the exact `buildReplicationStallBody` shape,
 * resolving only genuinely-nonexistent-harness targets, leaving
 * still-existing (even idle) harnesses untouched, malformed-body safety,
 * per-(workspace,harness) existence-check caching, fail-closed on an
 * existence-check error, and per-item resolve-failure isolation.
 */
import { describe, expect, it } from 'vitest';
import {
  parseStallEiTarget,
  runReplicationStallOrphanSweepOnce,
  ORPHAN_SWEEP_OWNER,
  type OrphanSweepDeps,
} from '../replication-stall-orphan-sweep';
import {
  REPLICATION_STALL_EI_TITLE_PREFIX,
  replicationStallEiTitle,
} from '../replication-stall-ei';

function bodyFor(workspaceId: string, harnessSlug: string, kind = 'no_replicator'): string {
  return (
    `Replication-liveness detector (P-004 / WI-1840, WI-183 class): log=abc123def456… has had 0 ` +
    `live replicator peers for 200s (was previously replicating)\n\n` +
    `workspace=${workspaceId} harness=${harnessSlug}\n` +
    `log_core_key=abc123def456\n` +
    `kind=${kind} stalledForMs=200000\n\n` +
    `Meaning: …`
  );
}

describe('parseStallEiTarget', () => {
  it('extracts workspace + harness from a real EI body', () => {
    expect(parseStallEiTarget(bodyFor('papercusp-workspace', 'hive-canary'))).toEqual({
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'hive-canary',
    });
  });

  it('returns null for a body with no workspace=/harness= stamp', () => {
    expect(parseStallEiTarget('some unrelated issue body with no target stamp')).toBeNull();
  });
});

describe('runReplicationStallOrphanSweepOnce', () => {
  function fakeDeps(opts: {
    open: Array<{ id: string; body: string }>;
    existing: Set<string>; // "workspace::harness" pairs that DO exist
    existenceErrorFor?: string; // throw for this "workspace::harness" pair
    resolveErrorFor?: string; // throw for this EI id
  }): { deps: OrphanSweepDeps; resolved: Array<{ id: string; note: string }>; existsCalls: string[] } {
    const resolved: Array<{ id: string; note: string }> = [];
    const existsCalls: string[] = [];
    return {
      resolved,
      existsCalls,
      deps: {
        listOpenReplicationStallEis: async () => opts.open,
        harnessExists: async (workspaceId, harnessSlug) => {
          const key = `${workspaceId}::${harnessSlug}`;
          existsCalls.push(key);
          if (opts.existenceErrorFor === key) throw new Error('db hiccup');
          return opts.existing.has(key);
        },
        resolve: async (id, note) => {
          if (opts.resolveErrorFor === id) throw new Error('resolve failed');
          resolved.push({ id, note });
        },
      },
    };
  }

  it('resolves an EI whose target harness no longer exists', async () => {
    const { deps, resolved } = fakeDeps({
      open: [{ id: 'EI-1', body: bodyFor('papercusp-workspace', 'papercup') }],
      existing: new Set(), // papercup no longer registered (renamed to papercusp)
    });
    const result = await runReplicationStallOrphanSweepOnce(deps);
    expect(result.resolvedIds).toEqual(['EI-1']);
    expect(result.orphanedTargets).toEqual(['papercusp-workspace::papercup']);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe('EI-1');
    expect(resolved[0].note).toContain("target harness 'papercup' no longer exists");
    expect(resolved[0].note).toContain("workspace 'papercusp-workspace'");
  });

  it('leaves an EI alone when its target harness still exists (even if idle)', async () => {
    const { deps, resolved } = fakeDeps({
      open: [{ id: 'EI-2', body: bodyFor('papercusp-workspace', 'hive-canary') }],
      existing: new Set(['papercusp-workspace::hive-canary']),
    });
    const result = await runReplicationStallOrphanSweepOnce(deps);
    expect(result.resolvedIds).toEqual([]);
    expect(result.orphanedTargets).toEqual([]);
    expect(resolved).toHaveLength(0);
  });

  it('skips a malformed body without touching it or erroring the pass', async () => {
    const { deps, resolved } = fakeDeps({
      open: [{ id: 'EI-3', body: 'no target stamp in here at all' }],
      existing: new Set(),
    });
    const result = await runReplicationStallOrphanSweepOnce(deps);
    expect(result.checked).toBe(1);
    expect(result.resolvedIds).toEqual([]);
    expect(resolved).toHaveLength(0);
  });

  it('caches the existence check per (workspace, harness) across many EIs for the same target', async () => {
    const { deps, existsCalls, resolved } = fakeDeps({
      open: [
        { id: 'EI-4a', body: bodyFor('papercusp-workspace', 'papercup', 'no_replicator') },
        { id: 'EI-4b', body: bodyFor('papercusp-workspace', 'papercup', 'connected_never_replicated') },
        { id: 'EI-4c', body: bodyFor('papercusp-workspace', 'papercup', 'frozen') },
      ],
      existing: new Set(),
    });
    const result = await runReplicationStallOrphanSweepOnce(deps);
    expect(existsCalls).toEqual(['papercusp-workspace::papercup']); // one check, not three
    expect(result.resolvedIds).toEqual(['EI-4a', 'EI-4b', 'EI-4c']);
    expect(resolved).toHaveLength(3);
  });

  it('fails CLOSED (never resolves) when the existence check itself errors', async () => {
    const { deps, resolved } = fakeDeps({
      open: [{ id: 'EI-5', body: bodyFor('generic-test', 'flaky-workspace-read') }],
      existing: new Set(),
      existenceErrorFor: 'generic-test::flaky-workspace-read',
    });
    const result = await runReplicationStallOrphanSweepOnce(deps);
    expect(result.resolvedIds).toEqual([]);
    expect(resolved).toHaveLength(0);
  });

  it('isolates a per-item resolve failure — one failing resolve never strands the rest', async () => {
    const { deps, resolved } = fakeDeps({
      open: [
        { id: 'EI-6a', body: bodyFor('papercusp-workspace', 'papercup') },
        { id: 'EI-6b', body: bodyFor('papercusp-workspace', 'papercup') },
      ],
      existing: new Set(),
      resolveErrorFor: 'EI-6a',
    });
    const result = await runReplicationStallOrphanSweepOnce(deps);
    expect(result.errors).toBe(1);
    expect(result.resolvedIds).toEqual(['EI-6b']);
    expect(resolved.map((r) => r.id)).toEqual(['EI-6b']);
  });

  it('stamps ORPHAN_SWEEP_OWNER-attributable notes (distinct from a real recovery sample)', () => {
    // The constant is exported so callers/tests can assert attribution without
    // re-deriving the resolver identity string.
    expect(ORPHAN_SWEEP_OWNER).toBe('system:replication-liveness-orphan-sweep');
  });

  it('returns an inert, zero-op result under VITEST with no deps (never touches real PG)', async () => {
    const result = await runReplicationStallOrphanSweepOnce();
    expect(result).toEqual({
      checked: 0,
      orphanedTargets: [],
      resolvedIds: [],
      errors: 0,
      skipped: { unparseableTarget: 0, targetExists: 0 },
    });
  });
});

/**
 * WI-37499 — the sweep must not identify its own population by a DERIVED tag.
 *
 * Measured 2026-08-09: selecting candidates by the `replication-liveness` topic
 * tag hid 100% of this sweep's genuine targets (6 orphans, oldest 34.8 days),
 * because the untagged rows are exactly the rows that also escape dedup. These
 * guards pin the two properties that make that class of blindness impossible to
 * reintroduce silently.
 */
describe('WI-37499: title-prefix selector contract', () => {
  it('every episode kind mints a title carrying the prefix the sweeps select on', () => {
    // If a future edit reshapes the title, this fails HERE rather than silently
    // orphaning the title-prefix leg of the sweep's candidate read.
    const kinds = [
      'no_replicator',
      'frozen',
      'connected_never_replicated',
      'expected_never_admitted',
      'drain_stalled',
      'drain_backlog_stalled',
      'drain_backlog_aged',
      'drain_orphan_tail',
      'drain_row_quarantined',
    ] as const;
    for (const kind of kinds) {
      const title = replicationStallEiTitle({
        harnessSlug: 'papercusp',
        logKeyHex: 'abc123def456789',
        kind: kind as Parameters<typeof replicationStallEiTitle>[0]['kind'],
      });
      expect(title.startsWith(REPLICATION_STALL_EI_TITLE_PREFIX)).toBe(true);
    }
  });

  it('the prefix is a strict prefix of a real title, never the whole of it', () => {
    // Guards the degenerate fix where the prefix is widened to match everything.
    const title = replicationStallEiTitle({
      harnessSlug: 'papercusp',
      logKeyHex: 'abc123def456789',
      kind: 'no_replicator',
    });
    expect(title.length).toBeGreaterThan(REPLICATION_STALL_EI_TITLE_PREFIX.length);
    expect(REPLICATION_STALL_EI_TITLE_PREFIX).not.toBe('');
  });
});

/**
 * WI-37499 — a pass that saw NOTHING must be distinguishable from one that
 * correctly found no orphan. Before this, the tick logged only when it resolved
 * something, so the sweep ran daily for weeks while structurally blind and
 * emitted output identical to a healthy no-op.
 */
describe('WI-37499: skip census makes a blind pass distinguishable', () => {
  function censusDeps(open: Array<{ id: string; body: string }>, existing: Set<string>): OrphanSweepDeps {
    return {
      listOpenReplicationStallEis: async () => open,
      harnessExists: async (w, h) => existing.has(`${w}::${h}`),
      resolve: async () => {},
    };
  }

  it('reports checked=0 with an all-zero census when it saw no candidates at all', async () => {
    const result = await runReplicationStallOrphanSweepOnce(censusDeps([], new Set()));
    expect(result.checked).toBe(0);
    expect(result.skipped).toEqual({ unparseableTarget: 0, targetExists: 0 });
  });

  it('attributes a still-existing target to targetExists, not to an empty pass', async () => {
    const result = await runReplicationStallOrphanSweepOnce(
      censusDeps(
        [{ id: 'EI-a', body: bodyFor('papercusp-workspace', 'papercusp') }],
        new Set(['papercusp-workspace::papercusp']),
      ),
    );
    // Same resolvedIds as the blind case above — ONLY the census separates them.
    expect(result.resolvedIds).toEqual([]);
    expect(result.checked).toBe(1);
    expect(result.skipped.targetExists).toBe(1);
  });

  it('attributes an unparseable body to its own bucket', async () => {
    const result = await runReplicationStallOrphanSweepOnce(
      censusDeps([{ id: 'EI-b', body: 'no target stamp' }], new Set()),
    );
    expect(result.skipped).toEqual({ unparseableTarget: 1, targetExists: 0 });
  });

  it('counts a fail-closed existence error as a target-exists skip (never a resolve)', async () => {
    const result = await runReplicationStallOrphanSweepOnce({
      listOpenReplicationStallEis: async () => [
        { id: 'EI-c', body: bodyFor('generic-test', 'flaky') },
      ],
      harnessExists: async () => {
        throw new Error('db hiccup');
      },
      resolve: async () => {
        throw new Error('must never be called');
      },
    });
    expect(result.resolvedIds).toEqual([]);
    expect(result.skipped.targetExists).toBe(1);
  });
});
