import { describe, expect, it } from 'vitest';
import {
  P2P_EXPECTED_PEERS,
  P521_JOURNEYS,
  buildP2pCandidateManifest,
  candidateArtifactDigest,
  type P2pCandidateProvenance,
  type P2pJourneyResult,
} from './p2p-candidate-manifest';
import { renderReadinessTable } from './current-readiness-manifest';

const NOW = Date.parse('2026-09-23T01:00:00.000Z');
const SHA = 'f22392a985e0bf1c3dc54365276b81a77bab84c1';
const hex = (c: string) => c.repeat(64);

const candidate: P2pCandidateProvenance = {
  version: '0.0.22',
  channel: 'alpha',
  sourceSha: SHA,
  artifacts: [
    { name: 'Papercusp_0.0.22_amd64.AppImage', sha256: hex('a') },
    { name: 'Papercusp_0.0.22_universal.dmg', sha256: hex('b') },
  ],
};

function passOn(digest: string, peers: readonly string[] = P2P_EXPECTED_PEERS): P2pJourneyResult {
  return {
    verdict: 'pass',
    reason: 'journey passed',
    measuredAt: '2026-09-23T00:59:00.000Z',
    evidence: [{ ref: 'run-1', kind: 'physical-drill' }],
    artifactDigest: digest,
    observedPeers: peers,
  };
}

describe('P-521 candidate manifest', () => {
  it('derives an order-independent content digest that changes with any artifact byte', () => {
    const reversed = candidateArtifactDigest([...candidate.artifacts].reverse());
    expect(candidateArtifactDigest(candidate.artifacts)).toBe(reversed);
    expect(candidateArtifactDigest(candidate.artifacts)).toMatch(/^[0-9a-f]{64}$/);
    const changed = candidateArtifactDigest([candidate.artifacts[0], { ...candidate.artifacts[1], sha256: hex('c') }]);
    expect(changed).not.toBe(reversed);
  });

  it('refuses an empty, malformed, or duplicate artifact set', () => {
    expect(() => candidateArtifactDigest([])).toThrow(/empty/);
    expect(() => candidateArtifactDigest([{ name: 'x', sha256: 'nothex' }])).toThrow(/malformed/);
    expect(() => candidateArtifactDigest([{ name: 'dir/x', sha256: hex('a') }])).toThrow(/basename/);
    expect(() =>
      candidateArtifactDigest([
        { name: 'x', sha256: hex('a') },
        { name: 'x', sha256: hex('b') },
      ]),
    ).toThrow(/duplicate/);
  });

  it('a freshly cut candidate is NO-GO: every journey unmeasured and missing both peers', async () => {
    const manifest = await buildP2pCandidateManifest({ candidate, now: NOW });
    expect(manifest.artifact.sha256).toBe(candidateArtifactDigest(candidate.artifacts));
    expect(manifest.artifact.sourceRevision).toBe(SHA);
    expect(manifest.artifact.id).toBe('desktop-v0.0.22-alpha@f22392a985e0');
    expect(manifest.current.go).toBe(false);
    expect(manifest.profile.go).toBe(false);
    const byKey = new Map(manifest.current.rows.map((r) => [r.capability, r]));
    for (const j of P521_JOURNEYS) {
      expect(byKey.get(j.key)?.state).toBe('unmeasured');
      expect(byKey.get(j.key)?.missingPeers).toEqual([...P2P_EXPECTED_PEERS]);
    }
  });

  it('source-closed F-items are journey dependencies, never rows of their own (D-036/D-037)', async () => {
    const manifest = await buildP2pCandidateManifest({ candidate, now: NOW });
    expect(manifest.current.rows.map((r) => r.capability)).toEqual(P521_JOURNEYS.map((j) => j.key));
    const deps = new Set(manifest.current.rows.flatMap((r) => r.dependencies));
    for (const item of ['P-512', 'P-513', 'P-514', 'P-515', 'P-516', 'P-517', 'P-518', 'P-520']) {
      expect(deps.has(item)).toBe(true);
    }
    expect(manifest.current.rows.filter((r) => r.state === 'passed-on-this-artifact')).toEqual([]);
  });

  it('a journey passes only on THIS artifact with every expected peer observed', async () => {
    const digest = candidateArtifactDigest(candidate.artifacts);
    const manifest = await buildP2pCandidateManifest({
      candidate,
      now: NOW,
      journeys: {
        'discovery-join': passOn(digest),
        'serving-identity-restart': passOn(digest, ['tower']),
        'github-bridge': passOn(hex('9')),
      },
    });
    const byKey = new Map(manifest.current.rows.map((r) => [r.capability, r]));
    expect(byKey.get('discovery-join')?.state).toBe('passed-on-this-artifact');
    expect(byKey.get('serving-identity-restart')?.state).toBe('advancing');
    expect(byKey.get('serving-identity-restart')?.missingPeers).toEqual(['mac-vm']);
    // evidence measured on a different artifact is refused, never counted
    expect(byKey.get('github-bridge')?.state).not.toBe('passed-on-this-artifact');
    expect(byKey.get('github-bridge')?.result).toBe('lineage-mismatch');
    expect(manifest.current.go).toBe(false);
  });

  it('GO only when all eight journeys pass on this artifact', async () => {
    const digest = candidateArtifactDigest(candidate.artifacts);
    const journeys = Object.fromEntries(P521_JOURNEYS.map((j) => [j.key, passOn(digest)]));
    const manifest = await buildP2pCandidateManifest({ candidate, now: NOW, journeys });
    expect(manifest.current.go).toBe(true);
    const failing = { ...journeys, 'full-installer-compat': { ...passOn(digest), verdict: 'fail' as const } };
    const refused = await buildP2pCandidateManifest({ candidate, now: NOW, journeys: failing });
    expect(refused.current.go).toBe(false);
    expect(refused.current.rows.find((r) => r.capability === 'full-installer-compat')?.state).toBe('failed-on-this-artifact');
  });

  it('refuses an unknown journey key and a malformed source sha', async () => {
    await expect(
      buildP2pCandidateManifest({ candidate, now: NOW, journeys: { 'not-a-journey': passOn(hex('a')) } }),
    ).rejects.toThrow(/unknown P-521 journey/);
    await expect(buildP2pCandidateManifest({ candidate: { ...candidate, sourceSha: 'abc' }, now: NOW })).rejects.toThrow(
      /40-char/,
    );
  });

  it('renders a readiness table naming every journey', async () => {
    const table = renderReadinessTable(await buildP2pCandidateManifest({ candidate, now: NOW }));
    for (const j of P521_JOURNEYS) expect(table).toContain(j.key);
  });
});
