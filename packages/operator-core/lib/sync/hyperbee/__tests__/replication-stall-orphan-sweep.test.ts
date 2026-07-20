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
    expect(result).toEqual({ checked: 0, orphanedTargets: [], resolvedIds: [], errors: 0 });
  });
});
