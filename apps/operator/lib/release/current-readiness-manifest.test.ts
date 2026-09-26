import { describe, expect, it } from 'vitest';
import type { ReleaseProfileVerdict } from '@papercusp/release-profile';
import type { ReadinessCapabilityInput } from './current-readiness-manifest';

// Test-only copy-out seam for scripts/mutation-probe.sh. The assertions still
// execute the production adapter, including its real lineage and peer checks.
const {
  appendReadinessHistory,
  buildCurrentReadinessManifest,
  deriveReadinessDependencyGraph,
  renderReadinessTable,
  serializeCurrentReadinessManifest,
} = await import(
  process.env.PROBE_CURRENT_READINESS_MANIFEST ?? './current-readiness-manifest'
) as typeof import('./current-readiness-manifest');

const NOW = '2026-09-05T03:00:00.000Z';

function profile(overrides: Partial<ReleaseProfileVerdict> = {}): ReleaseProfileVerdict {
  return {
    profileRef: 'p2p-public-release-readiness',
    evaluatedAt: NOW,
    go: true,
    reason: 'all mandatory components pass',
    components: [
      {
        key: 'replication',
        title: 'Replication convergence',
        mandatory: true,
        verdict: 'pass',
        reason: 'all expected readers converged',
        measuredAt: NOW,
        evidence: [{ ref: 'run-1', kind: 'gate-run', detail: { converged: 2 } }],
        lineage: { sha: 'artifact-sha' },
      },
    ],
    ...overrides,
  };
}

function capability(overrides: Partial<ReadinessCapabilityInput> = {}): ReadinessCapabilityInput {
  return {
    key: 'replication',
    scenario: 'two-peer-convergence',
    expectedPeers: ['peer-a', 'peer-b'],
    observedPeers: ['peer-a', 'peer-b'],
    owner: 'su-f54d7',
    dependencies: [],
    ...overrides,
  };
}

describe('current readiness manifest adapter', () => {
  it('derives a deterministic current row from the release-profile evidence', () => {
    const options = {
      profile: profile(),
      artifact: { id: 'candidate-1', sha256: 'artifact-sha' },
      capabilities: [capability()],
      now: NOW,
    };
    const first = buildCurrentReadinessManifest(options);
    const second = buildCurrentReadinessManifest(options);

    expect(second).toEqual(first);
    expect(first.schemaVersion).toBe(1);
    expect(first.current.go).toBe(true);
    expect(first.current.rows[0]).toMatchObject({
      capability: 'replication',
      artifactId: 'candidate-1',
      scenario: 'two-peer-convergence',
      state: 'passed-on-this-artifact',
      result: 'pass',
      expectedPeers: ['peer-a', 'peer-b'],
      missingPeers: [],
      owner: 'su-f54d7',
    });
    expect(first.current.rows[0]?.evidence.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(serializeCurrentReadinessManifest(first)).toBe(serializeCurrentReadinessManifest(second));
  });

  it('keeps skipped, unmeasured, source-tested, and advancing distinct', () => {
    const base = profile({
      components: [
        {
          key: 'skipped', title: 'Skipped', mandatory: false, verdict: 'unknown', reason: 'not in scope', measuredAt: NOW, evidence: [],
        },
        {
          key: 'unmeasured', title: 'Unmeasured', mandatory: true, verdict: 'unknown', reason: 'no run', measuredAt: NOW, evidence: [],
        },
        {
          key: 'source', title: 'Source', mandatory: true, verdict: 'pass', reason: 'source tests pass', measuredAt: NOW, evidence: [{ ref: 'source-run' }],
        },
        {
          key: 'advancing', title: 'Advancing', mandatory: true, verdict: 'pass', reason: 'one reader is catching up', measuredAt: NOW, evidence: [{ ref: 'live-run' }],
        },
      ],
    });
    const manifest = buildCurrentReadinessManifest({
      profile: base,
      artifact: 'candidate-1',
      capabilities: [
        capability({ key: 'skipped', executionState: 'skipped', expectedPeers: [], observedPeers: [] }),
        capability({ key: 'unmeasured', executionState: 'unmeasured', expectedPeers: [], observedPeers: [] }),
        capability({ key: 'source', executionState: 'source-tested', expectedPeers: [], observedPeers: [] }),
        capability({ key: 'advancing', expectedPeers: ['peer-a', 'peer-b'], observedPeers: ['peer-a'] }),
      ],
      now: NOW,
    });

    expect(manifest.current.rows.map((row) => row.state)).toEqual([
      'skipped',
      'unmeasured',
      'source-tested',
      'advancing',
    ]);
    expect(manifest.current.go).toBe(false);
  });

  it('F1 counterexample: a green stall-health component cannot pass while an expected peer is absent', () => {
    const manifest = buildCurrentReadinessManifest({
      profile: profile(),
      artifact: 'candidate-1',
      capabilities: [capability({ expectedPeers: ['peer-a', 'peer-b'], observedPeers: ['peer-a'] })],
      now: NOW,
    });

    expect(manifest.profile.go).toBe(true);
    expect(manifest.current.go).toBe(false);
    expect(manifest.current.rows[0]).toMatchObject({
      result: 'pass',
      state: 'advancing',
      missingPeers: ['peer-b'],
    });
  });

  it('refuses a component measured against a different artifact identity', () => {
    const manifest = buildCurrentReadinessManifest({
      profile: profile(),
      artifact: { id: 'candidate-2', sha256: 'different-sha' },
      capabilities: [capability()],
      now: NOW,
    });
    expect(manifest.current.go).toBe(false);
    expect(manifest.current.rows[0]).toMatchObject({
      result: 'lineage-mismatch',
      state: 'unmeasured',
    });
    expect(manifest.current.rows[0]?.reason).toContain('artifact lineage mismatch');
  });

  it('D-014 negative control: a bad population query cannot turn absent peers into a pass', () => {
    // The historical bad SQL filtered out legacy repo=NULL announcements. Model that
    // population loss as an observed set that omits the expected legacy peer; the
    // manifest must retain the omission as advancing evidence.
    const manifest = buildCurrentReadinessManifest({
      profile: profile(),
      artifact: 'candidate-1',
      capabilities: [capability({
        expectedPeers: ['legacy-repo-null-peer', 'peer-a'],
        observedPeers: ['peer-a'],
      })],
      now: NOW,
    });

    expect(manifest.current.rows[0]?.missingPeers).toEqual(['legacy-repo-null-peer']);
    expect(manifest.current.rows[0]?.state).toBe('advancing');
    expect(manifest.current.go).toBe(false);
  });

  it('retains history append-only and derives the remaining dependency graph and table', () => {
    const manifest = buildCurrentReadinessManifest({
      profile: profile({
        components: [
          profile().components[0]!,
          { key: 'dependent', title: 'Dependent', mandatory: true, verdict: 'unknown', reason: 'waiting', measuredAt: NOW, evidence: [] },
        ],
        go: false,
      }),
      artifact: 'candidate-1',
      capabilities: [
        capability({ dependencies: ['dependent'] }),
        capability({ key: 'dependent', expectedPeers: [], observedPeers: [] }),
      ],
      now: NOW,
    });
    const withHistory = appendReadinessHistory(manifest);
    expect(withHistory.history).toHaveLength(1);
    expect(manifest.history).toHaveLength(0);

    const graph = deriveReadinessDependencyGraph(withHistory);
    expect(graph.nodes).toEqual(expect.arrayContaining([
      { capability: 'replication', state: 'passed-on-this-artifact', remaining: false },
      { capability: 'dependent', state: 'unmeasured', remaining: true },
    ]));
    expect(graph.edges).toEqual([{ from: 'replication', to: 'dependent' }]);
    expect(renderReadinessTable(withHistory)).toContain('| replication | passed-on-this-artifact | pass |');
    expect(renderReadinessTable(withHistory)).toContain('| dependent | unmeasured | unknown |');
  });

  it('creates an unmeasured row when a required capability has no profile component', () => {
    const manifest = buildCurrentReadinessManifest({
      profile: profile(),
      artifact: 'candidate-1',
      capabilities: [capability({ key: 'delegated-seat', componentKey: 'missing-component', expectedPeers: [], observedPeers: [] })],
      now: NOW,
    });
    expect(manifest.current.go).toBe(false);
    expect(manifest.current.rows[0]).toMatchObject({ state: 'unmeasured', result: 'unknown' });
    expect(manifest.current.rows[0]?.reason).toContain('missing-component');
  });
});
