/**
 * Independent D292 consumer contract, WI-6554700010020476.
 * This refusal/dispatch slice is preparation, not six-outcome readiness.
 * Authentic original-record positive controls and physical outcomes remain owed.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeCandidateManifestFromRecords,
  type ComputeDeps,
  type ComputeOptions,
} from './run-p2p-candidate-manifest';

// Independent population: a production deletion must not shrink the oracle.
const SHIPPED_PLANS = [
  'p2p-coordination-public-release-2026-08-26',
  'p2p-public-release-remaining-lanes-2026-07-16',
  'p2p-git-live-activation-2026-07-09',
  'p2p-work-distribution-2026-07-02',
  'github-bridge-hive-egress-2026-07-02',
  'fleet-reliability-verification-2026-07-10',
] as const;
const ENDGAME_PLAN = 'p2p-public-release-endgame-2026-09-01';
const SOURCE_SHA = 'a'.repeat(40);
const DESKTOP_SHA = 'b'.repeat(40);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const ARTIFACT_SHA = sha256('private D292 artifact bytes');
// The artifact digest specification hashes sorted "<sha>  <basename>\n" lines.
const ARTIFACT_DIGEST = sha256(`${ARTIFACT_SHA}  Fixture.deb\n`);

interface ReadRequest {
  planSlug: string;
  phase: 'shipped' | 'pre-ship';
  sourceSha: string;
  artifactDigest: string;
}
type OriginalReader = (request: ReadRequest) => Promise<never | null>;
interface EndgameResult {
  shipmentLedger: readonly unknown[];
  preShip: unknown | null;
  checks: readonly { id: string; status: string; detail: string }[];
  ok: boolean;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(reader?: OriginalReader): { options: ComputeOptions; deps: ComputeDeps } {
  const root = mkdtempSync(join(tmpdir(), 'p403-p404-originals-'));
  roots.push(root);
  const provenancePath = join(root, 'build-provenance.json');
  writeFileSync(provenancePath, JSON.stringify({
    version: '0.0.25', buildSha: DESKTOP_SHA.slice(0, 12), gitHead: DESKTOP_SHA,
    gitDirty: false, gitDirtyAtEmit: false, reused: false,
    dirtySource: { status: 'captured', repositories: [
      { label: 'workspace', gitHead: SOURCE_SHA, files: [] },
      { label: 'desktop', gitHead: DESKTOP_SHA, files: [] },
    ] },
    builtAtUtc: '2026-10-22T10:00:00Z',
    artifacts: [{ name: 'Fixture.deb', sha256: ARTIFACT_SHA, bytes: 26, sig: true }],
  }));
  const deps: ComputeDeps = {
    readLedger: async () => ({
      version: '0.0.25', channel: 'alpha', gitSha: SOURCE_SHA,
      artifacts: [{ name: 'Fixture.deb', sha256: ARTIFACT_SHA }],
    }),
    readBuildCommand: async () => ({
      tool: 'release:cut', invocationId: 'private-D292-build',
      invokedAt: '2026-10-22T09:59:00Z', servingBuildSha: SOURCE_SHA,
      args: { op: 'run', version: '0.0.25', channel: 'alpha', confirm: true, sourceSha: SOURCE_SHA },
    }),
    hashFile: async () => ARTIFACT_SHA,
  };
  // Prospective optional member is deliberately installed at the maintained seam.
  // No absent production export is imported, so baseline red is an assertion.
  if (reader) Object.assign(deps, { readEndgameOriginals: reader });
  return {
    options: {
      version: '0.0.25', channel: 'alpha', legs: [{ leg: 'linux', path: provenancePath }],
      repoRoot: root, now: Date.parse('2026-10-22T10:01:00Z'),
    },
    deps,
  };
}

async function compute(reader?: OriginalReader) {
  const { options, deps } = fixture(reader);
  return computeCandidateManifestFromRecords(options, deps);
}

function refused(result: Awaited<ReturnType<typeof compute>>): EndgameResult {
  const endgame = Reflect.get(result, 'endgame') as EndgameResult | undefined;
  expect(endgame, 'computed consumer must expose missing original evidence').toEqual(expect.objectContaining({
    ok: false, shipmentLedger: expect.any(Array), checks: expect.any(Array),
  }));
  // The assertion above terminates a missing-result baseline before dereferencing.
  // D292 permits retained diagnostics; it does not prescribe empty output shapes.
  const evidence = endgame as EndgameResult;
  expect(Reflect.has(evidence, 'preShip')).toBe(true);
  for (const id of ['P-403', 'P-404']) {
    const aggregate = evidence.checks.filter(check => check.id === id);
    expect(aggregate, `${id} needs one retained aggregate diagnostic`).toHaveLength(1);
    expect(aggregate[0]!.status).not.toBe('pass');
  }
  return evidence;
}

describe('D292 prospective computed P403/P404 original-evidence consumer', () => {
  it('derives the exact source and artifact pins without an endgame reader (fixture control)', async () => {
    const result = await compute();
    expect(result.provenance.sourceSha).toBe(SOURCE_SHA);
    expect(result.provenance.provenance.candidateDigest).toBe(ARTIFACT_DIGEST);
    expect(result.manifest.artifact.sha256).toBe(ARTIFACT_DIGEST);
  });

  it('retains P403/P404 non-pass diagnostics when the original reader is absent', async () => {
    refused(await compute());
  });

  it('missing original packets never become a shipment or pre-ship proof', async () => {
    refused(await compute(async () => null));
  });

  it('requests exactly the six shipped originals on pins derived from the artifact bytes', async () => {
    const requests: ReadRequest[] = [];
    await compute(async request => { requests.push({ ...request }); return null; });
    expect(requests.filter(request => request.phase === 'shipped')).toHaveLength(SHIPPED_PLANS.length);
    expect(requests.filter(request => request.phase === 'shipped')).toEqual(expect.arrayContaining(
      SHIPPED_PLANS.map(planSlug => ({
        planSlug, phase: 'shipped', sourceSha: SOURCE_SHA, artifactDigest: ARTIFACT_DIGEST,
      })),
    ));
  });

  it('requests the endgame pre-ship package without requiring this plan already shipped', async () => {
    const requests: ReadRequest[] = [];
    await compute(async request => { requests.push({ ...request }); return null; });
    expect(requests.filter(request => request.planSlug === ENDGAME_PLAN)).toEqual([{
      planSlug: ENDGAME_PLAN, phase: 'pre-ship', sourceSha: SOURCE_SHA, artifactDigest: ARTIFACT_DIGEST,
    }]);
    expect(requests).toHaveLength(SHIPPED_PLANS.length + 1);
  });

  it('reader errors remain inspectable non-pass results rather than provenance-only success', async () => {
    refused(await compute(async () => { throw new Error('private original record lookup unavailable'); }));
  });

  it.each(['status-only', 'local-witness-only', 'shortcut-flags', 'reference-only', 'empty-originals'])(
    'rejects %s even when it repeats the exact requested candidate pins', async variant => {
      const reader: OriginalReader = async request => {
        const pins = { sourceSha: request.sourceSha, artifactDigest: request.artifactDigest };
        const packet = variant === 'status-only'
          ? { ...pins, planSlug: request.planSlug, status: 'shipped', skipped: 'already-shipped' }
          : variant === 'local-witness-only'
            ? { ...pins, localShipmentCaptured: true, rubricRetiredWithShipment: true }
            : variant === 'shortcut-flags'
              ? { ...pins, authenticated: true, eligible: true, passed: true }
              : variant === 'reference-only'
                ? { ...pins, planRevision: 'plan-revision:1', codeTruthAudits: ['plan-audit:1'],
                  acceptanceRubric: 'acceptance-fixture', rubricVetting: 'consult:1', countedScorecards: ['EI-1'],
                  gradingAudits: ['EI-2'], graderEligibility: 'lineage:1', authorVerdicts: ['EI-3'],
                  candidateBindings: ['candidate:1'], portfolioCensus: 'census:1' }
                : { planRevision: null, codeTruthAudits: [], acceptanceRubric: null, rubricVetting: null,
                  countedScorecards: [], gradingAudits: [], graderEligibility: [], authorVerdicts: [],
                  candidateBindings: [], portfolioCensus: null };
        // Adversarial inputs intentionally violate the prospective packet types.
        return packet as never;
      };
      refused(await compute(reader));
    },
  );
});
