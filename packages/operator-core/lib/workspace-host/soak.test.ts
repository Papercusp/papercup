import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKSPACE_HOST_SOAK_POLICY,
  WORKSPACE_HOST_SOAK_SCHEMA_VERSION,
  WorkspaceHostSoakPolicyError,
  WorkspaceHostSoakSubjectError,
  evaluateWorkspaceHostSoak,
  parseWorkspaceHostSoakSample,
  pinWorkspaceHostSoakSubject,
  probeWorkspaceHostSoakSample,
  resolveWorkspaceHostSoakPolicy,
  workspaceHostSoakAttestation,
  workspaceHostSoakDecidedEarly,
  workspaceHostSoakQualifiesForAcceptance,
  type WorkspaceHostSoakInstanceReading,
  type WorkspaceHostSoakPolicy,
  type WorkspaceHostSoakReachOutcome,
  type WorkspaceHostSoakSample,
  type WorkspaceHostSoakSubject,
} from './soak';

const IMAGE = 'https://www.googleapis.com/compute/v1/projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260918';
const SUBJECT: WorkspaceHostSoakSubject = {
  workspaceId: 'ws-1',
  hostId: 'host-1',
  soakId: 'soak-1',
  instanceId: '1100961087771032429',
  image: IMAGE,
};
const T0 = Date.parse('2026-09-23T00:00:00.000Z');
const POLICY: WorkspaceHostSoakPolicy = DEFAULT_WORKSPACE_HOST_SOAK_POLICY;

const running: WorkspaceHostSoakInstanceReading = {
  kind: 'observed',
  status: 'RUNNING',
  instanceId: SUBJECT.instanceId,
  sourceImage: IMAGE,
};

async function sampleAt(
  sequence: number,
  reading: WorkspaceHostSoakInstanceReading = running,
  reach: WorkspaceHostSoakReachOutcome = { kind: 'reached' },
  atMs = T0 + sequence * POLICY.intervalMs,
): Promise<WorkspaceHostSoakSample> {
  return probeWorkspaceHostSoakSample(SUBJECT, sequence, {
    readInstance: async () => reading,
    probeReach: async () => reach,
    now: () => new Date(atMs),
  });
}

/** A full clean window: 289 samples, 5 minutes apart, spanning exactly 24h. */
async function cleanWindow(overrides: Map<number, Promise<WorkspaceHostSoakSample>> = new Map()) {
  const count = Math.floor(POLICY.durationMs / POLICY.intervalMs) + 1;
  return Promise.all(
    Array.from({ length: count }, (_, sequence) => overrides.get(sequence) ?? sampleAt(sequence)),
  );
}

describe('resolveWorkspaceHostSoakPolicy', () => {
  it('defaults to a 24h window sampled every 5 minutes, which qualifies for acceptance', () => {
    const policy = resolveWorkspaceHostSoakPolicy();
    expect(policy.durationMs).toBe(24 * 60 * 60_000);
    expect(policy.intervalMs).toBe(5 * 60_000);
    expect(workspaceHostSoakQualifiesForAcceptance(policy)).toBe(true);
  });

  it('allows a short smoke soak but marks it as NOT qualifying for the acceptance stage', () => {
    const policy = resolveWorkspaceHostSoakPolicy({ durationMs: 10 * 60_000, intervalMs: 60_000 });
    expect(workspaceHostSoakQualifiesForAcceptance(policy)).toBe(false);
  });

  it('refuses an interval below one minute and a duration shorter than one interval', () => {
    expect(() => resolveWorkspaceHostSoakPolicy({ intervalMs: 1_000 })).toThrow(WorkspaceHostSoakPolicyError);
    expect(() => resolveWorkspaceHostSoakPolicy({ durationMs: 30_000, intervalMs: 60_000 })).toThrow(
      WorkspaceHostSoakPolicyError,
    );
  });
});

describe('pinWorkspaceHostSoakSubject', () => {
  const identity = { workspaceId: 'ws-1', hostId: 'host-1', soakId: 'soak-1' };

  it('pins the incarnation and boot image of a RUNNING instance', () => {
    expect(pinWorkspaceHostSoakSubject(identity, running)).toEqual(SUBJECT);
  });

  it.each<[string, WorkspaceHostSoakInstanceReading]>([
    ['absent', { kind: 'absent' }],
    ['unreadable', { kind: 'unreadable', detail: 'HTTP 503' }],
    ['stopped', { kind: 'observed', status: 'TERMINATED', instanceId: '1', sourceImage: IMAGE }],
    ['no instance id', { kind: 'observed', status: 'RUNNING', sourceImage: IMAGE }],
    ['no image', { kind: 'observed', status: 'RUNNING', instanceId: '1' }],
  ])('refuses to begin a soak on a host that is %s', (_label, reading) => {
    expect(() => pinWorkspaceHostSoakSubject(identity, reading)).toThrow(WorkspaceHostSoakSubjectError);
  });
});

describe('probeWorkspaceHostSoakSample', () => {
  it('records all four checks passing for the pinned, reachable machine', async () => {
    const sample = await sampleAt(0);
    expect(sample.checks.map((check) => [check.name, check.ok])).toEqual([
      ['compute-running', true],
      ['incarnation-stable', true],
      ['image-stable', true],
      ['controller-reach', true],
    ]);
  });

  it('fails incarnation-stable when the instance was RECREATED under the same name (never re-baselines)', async () => {
    const sample = await sampleAt(1, { ...running, instanceId: '4099111017888268059' });
    const check = sample.checks.find((entry) => entry.name === 'incarnation-stable');
    expect(check?.ok).toBe(false);
    expect(sample.pinned.instanceId).toBe(SUBJECT.instanceId);
  });

  it('records a provider read error as UNMEASURED, not failed, and still probes reach', async () => {
    const sample = await probeWorkspaceHostSoakSample(SUBJECT, 2, {
      readInstance: async () => {
        throw new Error('compute API 503');
      },
      probeReach: async () => ({ kind: 'reached' }),
      now: () => new Date(T0),
    });
    expect(sample.checks.filter((check) => check.ok === null).map((check) => check.name)).toEqual([
      'compute-running',
      'incarnation-stable',
      'image-stable',
    ]);
    expect(sample.checks.find((check) => check.name === 'controller-reach')?.ok).toBe(true);
  });

  it('keeps conduit-missing and transport-failure distinguishable in the reach detail', async () => {
    const missing = await sampleAt(3, running, { kind: 'conduit-missing', detail: 'answered 3x' });
    const transport = await sampleAt(4, running, { kind: 'transport-failure', detail: 'exit 255' });
    expect(missing.checks.at(-1)).toMatchObject({ ok: false, detail: 'conduit-missing: answered 3x' });
    expect(transport.checks.at(-1)).toMatchObject({ ok: false, detail: 'transport-failure: exit 255' });
  });

  it('attests the host row degraded when a measured check fails, unreachable when compute is down', async () => {
    const healthy = workspaceHostSoakAttestation('host-1', await sampleAt(0));
    const degraded = workspaceHostSoakAttestation(
      'host-1',
      await sampleAt(1, running, { kind: 'transport-failure', detail: 'exit 255' }),
    );
    const down = workspaceHostSoakAttestation('host-1', await sampleAt(2, { kind: 'absent' }));
    expect([healthy.status, degraded.status, down.status]).toEqual(['healthy', 'degraded', 'unreachable']);
  });
});

describe('parseWorkspaceHostSoakSample', () => {
  it('round-trips a sample through its persisted JSON form', async () => {
    const sample = await sampleAt(7);
    expect(parseWorkspaceHostSoakSample(JSON.parse(JSON.stringify(sample)))).toEqual(sample);
  });

  it('rejects malformed rows, so they cost coverage instead of being trusted', async () => {
    const sample = await sampleAt(0);
    expect(parseWorkspaceHostSoakSample(null)).toBeNull();
    expect(parseWorkspaceHostSoakSample({ ...sample, schemaVersion: WORKSPACE_HOST_SOAK_SCHEMA_VERSION + 1 })).toBeNull();
    expect(parseWorkspaceHostSoakSample({ ...sample, observedAt: 'not a date' })).toBeNull();
    expect(
      parseWorkspaceHostSoakSample({ ...sample, checks: [{ name: 'compute-running', ok: 'yes' }] }),
    ).toBeNull();
  });
});

describe('evaluateWorkspaceHostSoak', () => {
  it('POSITIVE CONTROL: a full, clean 24h window passes', async () => {
    const result = evaluateWorkspaceHostSoak({ samples: await cleanWindow(), policy: POLICY });
    expect(result).toMatchObject({
      verdict: 'pass',
      soakId: 'soak-1',
      samples: 289,
      measuredSamples: 289,
      expectedSamples: 289,
      maxGapMs: POLICY.intervalMs,
      reasons: [],
    });
  });

  it('reports a clean but incomplete window as running, and as FAILED once sampling has ended', async () => {
    const partial = (await cleanWindow()).slice(0, 12);
    expect(evaluateWorkspaceHostSoak({ samples: partial, policy: POLICY }).verdict).toBe('running');
    const ended = evaluateWorkspaceHostSoak({ samples: partial, policy: POLICY, ended: true });
    expect(ended.verdict).toBe('fail');
    expect(ended.reasons.join('\n')).toMatch(/before the \d+ms window was covered/);
  });

  it('fails on a single strict failure — one stopped sample sinks the day', async () => {
    const samples = await cleanWindow(
      new Map([[100, sampleAt(100, { ...running, status: 'STOPPING' })]]),
    );
    const result = evaluateWorkspaceHostSoak({ samples, policy: POLICY });
    expect(result.verdict).toBe('fail');
    expect(result.failures['compute-running']).toBe(1);
    expect(result.reasons[0]).toMatch(/^compute-running failed 1x, first sample 100/);
  });

  it('fails when the machine was re-imaged mid-soak', async () => {
    const samples = await cleanWindow(
      new Map([[200, sampleAt(200, { ...running, sourceImage: `${IMAGE}-other` })]]),
    );
    expect(evaluateWorkspaceHostSoak({ samples, policy: POLICY }).reasons.join('\n')).toMatch(/image-stable failed/);
  });

  it('tolerates an isolated reach flake but fails two consecutive reach failures', async () => {
    const flake: WorkspaceHostSoakReachOutcome = { kind: 'transport-failure', detail: 'exit 255' };
    const one = await cleanWindow(new Map([[50, sampleAt(50, running, flake)]]));
    expect(evaluateWorkspaceHostSoak({ samples: one, policy: POLICY }).verdict).toBe('pass');

    const two = await cleanWindow(
      new Map([
        [50, sampleAt(50, running, flake)],
        [51, sampleAt(51, running, flake)],
      ]),
    );
    const result = evaluateWorkspaceHostSoak({ samples: two, policy: POLICY });
    expect(result.verdict).toBe('fail');
    expect(result.maxConsecutiveReachFailures).toBe(2);
  });

  it('fails when isolated reach flakes exceed the tolerated rate', async () => {
    const flake: WorkspaceHostSoakReachOutcome = { kind: 'transport-failure', detail: 'exit 255' };
    // 8 non-adjacent failures of 289 = 2.77% > 2%.
    const overrides = new Map([10, 40, 70, 100, 130, 160, 190, 220].map((seq) => [seq, sampleAt(seq, running, flake)]));
    const result = evaluateWorkspaceHostSoak({ samples: await cleanWindow(overrides), policy: POLICY });
    expect(result.verdict).toBe('fail');
    expect(result.reasons.join('\n')).toMatch(/controller-reach failed on 2\.77% of samples/);
  });

  it('fails a gap longer than three intervals (the sampler stopped watching)', async () => {
    const samples = (await cleanWindow()).filter((sample) => sample.sequence < 20 || sample.sequence > 23);
    const result = evaluateWorkspaceHostSoak({ samples, policy: POLICY });
    expect(result.verdict).toBe('fail');
    expect(result.maxGapMs).toBe(5 * POLICY.intervalMs);
  });

  it('counts unmeasured provider reads against coverage instead of failing them outright', async () => {
    const unreadable: WorkspaceHostSoakInstanceReading = { kind: 'unreadable', detail: 'HTTP 503' };
    const few = await cleanWindow(new Map([[5, sampleAt(5, unreadable)], [99, sampleAt(99, unreadable)]]));
    const fewResult = evaluateWorkspaceHostSoak({ samples: few, policy: POLICY });
    expect(fewResult.verdict).toBe('pass');
    expect(fewResult.measuredSamples).toBe(287);

    // 20 of 289 unmeasured leaves 269 < ceil(289 * 0.95) = 275.
    const many = await cleanWindow(
      new Map(Array.from({ length: 20 }, (_, index) => [index * 14, sampleAt(index * 14, unreadable)])),
    );
    const manyResult = evaluateWorkspaceHostSoak({ samples: many, policy: POLICY });
    expect(manyResult.verdict).toBe('fail');
    expect(manyResult.reasons.join('\n')).toMatch(/only 269 fully-measured samples \(need 275 of 289\)/);
  });

  it('refuses to judge a mixture of two soaks as one', async () => {
    const samples = await cleanWindow();
    samples[3] = { ...samples[3]!, soakId: 'soak-2' };
    const result = evaluateWorkspaceHostSoak({ samples, policy: POLICY });
    expect(result.verdict).toBe('fail');
    expect(result.soakId).toBeNull();
  });

  it('decides early on a strict failure so the sampler can stop instead of waiting out the day', async () => {
    const early = [await sampleAt(0), await sampleAt(1, { kind: 'absent' })];
    expect(workspaceHostSoakDecidedEarly(early, POLICY)).toBe(true);
    expect(workspaceHostSoakDecidedEarly([await sampleAt(0), await sampleAt(1)], POLICY)).toBe(false);
  });
});
