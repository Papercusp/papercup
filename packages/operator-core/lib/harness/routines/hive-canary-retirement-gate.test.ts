/**
 * The retired-tier gate on both canary actions
 * (retire-mug-kettle-su-only-2026-08-09 P-051 / D-045).
 *
 * WHAT THIS PINS, and why it is not merely a restatement of the code: the two
 * canary detectors measure whether the AUTONOMOUS CUP LOOP carries queued work
 * end-to-end — `isVoidedCanaryOwner` accepts a cup session as THE ONLY VALID
 * PASS. The cup tier is retired (D-001) and cannot spawn while
 * `papercusp-mug-kettle-system` is OFF, so every tick could only produce a
 * false alarm: an un-terminal canary reported as an SLA breach / daily miss, or
 * an su-completed one reported as a VOID measurement.
 *
 * The routine ROWS were disarmed too, but a row is one UPDATE (or one re-seed)
 * away from firing again — this gate is the half that cannot silently
 * resurrect, so it is the half worth a test.
 *
 * FALSIFIABILITY: each assertion is that `loadHarnessRegistry` was NOT called.
 * That call is the FIRST thing each action does after the gate, so deleting the
 * gate turns every assertion here red rather than leaving a test that passes
 * for the wrong reason. The flag-ON cases assert the inverse — the actions must
 * still run when the tier is re-enabled for testing — so a gate hard-wired to
 * "always skip" fails just as loudly as a missing one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mugKettleEnabledMock, loadHarnessRegistryMock, captureImprovementMock, sqlMock } = vi.hoisted(
  () => ({
    mugKettleEnabledMock: vi.fn(async () => false),
    loadHarnessRegistryMock: vi.fn(async () => ({ projects: [{ slug: 'hive-canary', hive_slug: 'papercusp' }] })),
    captureImprovementMock: vi.fn(async () => ({ created: false, issue: null, reason: 'stub' })),
    sqlMock: vi.fn(async () => []),
  }),
);

vi.mock('../../pot/started', () => ({ mugKettleSystemEnabled: mugKettleEnabledMock }));
vi.mock('../../harness-registry', () => ({ loadHarnessRegistry: loadHarnessRegistryMock }));
vi.mock('../improvements/capture-core', () => ({ captureImprovement: captureImprovementMock }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: sqlMock }) }));
vi.mock('../../owner-steering', () => ({
  getOwnerSteering: vi.fn(async () => ({})),
  isPausedNow: vi.fn(() => false),
}));
vi.mock('../../pot/urgent-wake', () => ({ requestUrgentPotWake: vi.fn(async () => ({ error: null })) }));
vi.mock('../../pot-membership', () => ({ routineStorageSlug: vi.fn(async () => 'papercusp') }));

// Import AFTER the mocks so the module's registerSystemAction side-effect binds them.
import { getSystemAction } from './system-actions';
import './hive-canary-action';

const ctx = {
  installSlug: 'hive-canary',
  workspaceId: 'papercusp-workspace',
  triggerConfig: {},
  payloadTemplate: null,
};

beforeEach(() => {
  loadHarnessRegistryMock.mockClear();
  captureImprovementMock.mockClear();
  sqlMock.mockClear();
  mugKettleEnabledMock.mockResolvedValue(false);
});

describe.each([
  ['hive-canary', 'the daily 6h CHECK+QUEUE'],
  ['hive-canary-sla', 'the ~15min fast SLA sweep'],
])('%s (%s) — retired-tier gate', (actionName) => {
  it('no-ops before touching the registry while the cup tier is retired', async () => {
    mugKettleEnabledMock.mockResolvedValue(false);
    const action = getSystemAction(actionName)!;
    expect(action).toBeTypeOf('function');

    await expect(action(ctx)).resolves.toBeUndefined();

    // The gate sits ahead of every side effect: no registry read, no DB read,
    // and — the point of the whole change — no bug filed about a subsystem the
    // owner deliberately retired.
    expect(loadHarnessRegistryMock).not.toHaveBeenCalled();
    expect(sqlMock).not.toHaveBeenCalled();
    expect(captureImprovementMock).not.toHaveBeenCalled();
  });

  it('still runs when the tier is re-enabled for testing (the gate is not a hard-wired skip)', async () => {
    mugKettleEnabledMock.mockResolvedValue(true);
    const action = getSystemAction(actionName)!;

    await action(ctx);

    // Proves the gate reads the flag rather than always returning early — the
    // detector must come back intact when the flag is flipped ON.
    expect(loadHarnessRegistryMock).toHaveBeenCalled();
  });
});
