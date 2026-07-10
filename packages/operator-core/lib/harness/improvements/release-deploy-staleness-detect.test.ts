/**
 * release-deploy-staleness-detect.test.ts (EI-9136).
 * Pure detector tests + a mocked-IO collector test. Mirrors
 * release-deploy-staleness-watchdog.test.ts's mocking shape for the shared
 * gitPipelineSnapshot/computeDeployStatus IO seams.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const gitPipelineSnapshot = vi.fn().mockResolvedValue({});
vi.mock('../../git-pipeline-stats', () => ({ gitPipelineSnapshot: (...a: unknown[]) => gitPipelineSnapshot(...a) }));

const computeDeployStatus = vi.fn();
vi.mock('../../release-deploy-launch', () => ({ computeDeployStatus: (...a: unknown[]) => computeDeployStatus(...a) }));

vi.mock('../operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));

import { detectReleaseDeployStaleness, collectReleaseDeployStalenessSignals } from './release-deploy-staleness-detect';
import type { DeployStalenessVerdict } from '../../release-deploy-staleness-watchdog';

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC;
});

const healthyVerdict: DeployStalenessVerdict = { stale: false, reason: 'deployedAt age 1h is under the threshold', ageMs: HOUR };
const staleVerdict: DeployStalenessVerdict = {
  stale: true,
  reason: 'green pin has been deployable-but-not-live for 13h (>= the 3h threshold) — the release-trigger routine (documented ≤15-min cadence) should have shipped it long ago.',
  ageMs: 13 * HOUR,
};

describe('detectReleaseDeployStaleness (pure)', () => {
  it('emits nothing for a healthy (non-stale) verdict', () => {
    expect(detectReleaseDeployStaleness(healthyVerdict)).toEqual([]);
  });

  it('emits ONE major, operator-scoped, change-kind finding for a stale verdict', () => {
    const findings = detectReleaseDeployStaleness(staleVerdict);
    expect(findings).toHaveLength(1);
    expect(findings[0].source).toBe('release-deploy-staleness');
    expect(findings[0].key).toBe('release-deploy-staleness');
    expect(findings[0].severity).toBe('major');
    expect(findings[0].kind).toBe('change');
    expect(findings[0].scope).toBe('operator');
    expect(findings[0].body).toContain('13h');
    expect(findings[0].body).toContain('EI-9136');
  });

  it('carries the underlying decider reason verbatim in the body (no re-derived logic)', () => {
    const findings = detectReleaseDeployStaleness(staleVerdict);
    expect(findings[0].body).toContain(staleVerdict.reason);
  });
});

describe('collectReleaseDeployStalenessSignals (mocked IO)', () => {
  it('emits nothing when the kill switch is set (<=0)', async () => {
    process.env.PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC = '0';
    const result = await collectReleaseDeployStalenessSignals({ now: NOW });
    expect(result.signals).toEqual([]);
    expect(result.note).toMatch(/kill switch/);
    expect(gitPipelineSnapshot).not.toHaveBeenCalled();
  });

  it('emits nothing when the pipeline is healthy (state not green-deployable)', async () => {
    computeDeployStatus.mockReturnValue({ state: 'up-to-date', deploy: { deployedAtMs: NOW - 999 * HOUR } });
    const result = await collectReleaseDeployStalenessSignals({ now: NOW, installSlug: 'papercusp' });
    expect(result.signals).toEqual([]);
    expect(gitPipelineSnapshot).toHaveBeenCalledWith('papercusp');
  });

  it('emits a finding when green-deployable has sat past the threshold', async () => {
    process.env.PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC = String(3 * 3600); // 3h
    computeDeployStatus.mockReturnValue({ state: 'green-deployable', deploy: { deployedAtMs: NOW - 13 * HOUR } });
    const result = await collectReleaseDeployStalenessSignals({ now: NOW, installSlug: 'papercusp' });
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].source).toBe('release-deploy-staleness');
    expect(result.signals[0].body).toContain('13h');
  });

  it('fails soft (empty signals + a note) when the pipeline snapshot throws', async () => {
    gitPipelineSnapshot.mockRejectedValueOnce(new Error('boom'));
    const result = await collectReleaseDeployStalenessSignals({ now: NOW });
    expect(result.signals).toEqual([]);
    expect(result.note).toMatch(/boom/);
  });

  it('defaults installSlug via operatorHomeHarnessSlug when none is passed', async () => {
    computeDeployStatus.mockReturnValue({ state: 'up-to-date', deploy: { deployedAtMs: NOW } });
    await collectReleaseDeployStalenessSignals({ now: NOW });
    expect(gitPipelineSnapshot).toHaveBeenCalledWith('papercusp');
  });
});
