/**
 * release-deploy-staleness-watchdog.test.ts (WI-1623).
 * Pure tests for the staleness decider + the sweep's alert/debounce/kill-switch
 * shell. IO deps (PG, the pipeline snapshot) are mocked.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { vi } from 'vitest';

const recentWatchdogFires = vi.fn().mockResolvedValue(0);
const recordFire = vi.fn().mockResolvedValue(undefined);
vi.mock('./hive/watchdog', () => ({ recentWatchdogFires: (...a: unknown[]) => recentWatchdogFires(...a), recordFire: (...a: unknown[]) => recordFire(...a) }));

const gitPipelineSnapshot = vi.fn().mockResolvedValue({});
vi.mock('./git-pipeline-stats', () => ({ gitPipelineSnapshot: (...a: unknown[]) => gitPipelineSnapshot(...a) }));

const computeDeployStatus = vi.fn();
vi.mock('./release-deploy-launch', () => ({ computeDeployStatus: (...a: unknown[]) => computeDeployStatus(...a) }));

import {
  evaluateDeployStaleness,
  deployStalenessThresholdSec,
  releaseDeployStalenessSweep,
} from './release-deploy-staleness-watchdog';
import type { DeployStateKind } from './release-deploy-launch';

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

function status(state: DeployStateKind, deployedAtMs: number | null) {
  return { state, deploy: { deployedAtMs } };
}

describe('evaluateDeployStaleness', () => {
  const thresholdMs = 3 * HOUR;

  it('is never stale below the threshold', () => {
    const v = evaluateDeployStaleness({ state: 'green-deployable', deployedAtMs: NOW - HOUR, now: NOW, thresholdMs });
    expect(v.stale).toBe(false);
  });

  it('flags stale once the green pin has sat deployable past the threshold', () => {
    const v = evaluateDeployStaleness({ state: 'green-deployable', deployedAtMs: NOW - 4 * HOUR, now: NOW, thresholdMs });
    expect(v.stale).toBe(true);
    expect(v.reason).toMatch(/deployable-but-not-live for 4h/);
  });

  it('is never stale outside the green-deployable state (up-to-date/gate-red/etc — something else already explains it)', () => {
    for (const s of ['up-to-date', 'gate-red', 'gate-wedged', 'staging-buffered', 'unknown'] as DeployStateKind[]) {
      expect(evaluateDeployStaleness({ state: s, deployedAtMs: NOW - 999 * HOUR, now: NOW, thresholdMs }).stale).toBe(false);
    }
  });

  it('flags stale when deployedAtMs is unresolvable (null) while green code waits — unknown is not assumed healthy', () => {
    const v = evaluateDeployStaleness({ state: 'green-deployable', deployedAtMs: null, now: NOW, thresholdMs });
    expect(v.stale).toBe(true);
    expect(v.reason).toMatch(/unresolvable/);
  });

  it('kill switch: thresholdMs <= 0 is never stale', () => {
    expect(evaluateDeployStaleness({ state: 'green-deployable', deployedAtMs: null, now: NOW, thresholdMs: 0 }).stale).toBe(false);
    expect(evaluateDeployStaleness({ state: 'green-deployable', deployedAtMs: NOW - 999 * HOUR, now: NOW, thresholdMs: -1 }).stale).toBe(false);
  });
});

describe('deployStalenessThresholdSec tunable', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to 3h', () => {
    delete process.env.PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC;
    expect(deployStalenessThresholdSec()).toBe(10_800);
  });

  it('honors the env override (and <=0 = kill switch)', () => {
    process.env.PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC = '60';
    expect(deployStalenessThresholdSec()).toBe(60);
    process.env.PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC = '0';
    expect(deployStalenessThresholdSec()).toBe(0);
  });
});

describe('releaseDeployStalenessSweep', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC;
  });

  it('alerts + records a fire when stale and not already debounced', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    computeDeployStatus.mockReturnValue(status('green-deployable', Date.now() - 999 * HOUR));
    recentWatchdogFires.mockResolvedValueOnce(0);
    const res = await releaseDeployStalenessSweep({});
    expect(res.outcome).toBe('alerted');
    expect(recordFire).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'release-deploy-staleness', wakeAt: null }),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[release-deploy-staleness] ALERT'));
    warn.mockRestore();
  });

  it('skips (debounced) when already fired recently', async () => {
    computeDeployStatus.mockReturnValue(status('green-deployable', Date.now() - 999 * HOUR));
    recentWatchdogFires.mockResolvedValueOnce(1);
    const res = await releaseDeployStalenessSweep({});
    expect(res.outcome).toBe('skipped');
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('is a no-op (healthy) when the pipeline is not in green-deployable', async () => {
    computeDeployStatus.mockReturnValue(status('up-to-date', Date.now() - 999 * HOUR));
    const res = await releaseDeployStalenessSweep({});
    expect(res.outcome).toBe('healthy');
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('kill switch skips entirely without touching PG', async () => {
    process.env.PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC = '0';
    const res = await releaseDeployStalenessSweep({});
    expect(res.outcome).toBe('skipped');
    expect(gitPipelineSnapshot).not.toHaveBeenCalled();
  });

  it('degrades to outcome:error, never throws, on a snapshot failure', async () => {
    gitPipelineSnapshot.mockRejectedValueOnce(new Error('pg down'));
    await expect(releaseDeployStalenessSweep({})).resolves.toMatchObject({ outcome: 'error' });
  });
});
