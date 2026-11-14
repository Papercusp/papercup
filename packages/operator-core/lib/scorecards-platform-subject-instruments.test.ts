import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveScorecardInstrumentSnapshots } from './scorecards';
import * as registry from './rubric-instrument-registry';
import type { PlatformInstrument } from './rubric-instrument-registry';
import type { Rubric } from './rubrics';

const key = 'fixture:fleet-window';
const subject = { kind: 'fleet' as const, ref: 'fleet-a',
  windowStart: '2026-10-01T00:00:00Z', windowEnd: '2026-10-02T00:00:00Z' };
const rubric = { workspaceId: 'ws', subjectHarnessSlug: 'papercusp',
  criteria: [{ key: 'criterion', check: { kind: 'instrument', instrumentKey: key } }] } as unknown as Rubric;
const now = () => Date.parse('2026-10-03T00:00:00Z');

function install(resolve: NonNullable<PlatformInstrument['rescore']>['resolve']) {
  vi.spyOn(registry, 'platformComputedInstrumentKeys').mockReturnValue([key]);
  vi.spyOn(registry, 'getRegisteredInstrument').mockReturnValue({ key, evaluator: 'platform',
    description: 'Fixture subject window', resolvedBy: 'scorecards:instrument-snapshots',
    rescore: { scope: 'subject', windowMs: 86_400_000, unit: 'count', resolve } });
}

afterEach(() => vi.restoreAllMocks());

describe('registered subject-scoped platform instruments', () => {
  it('resolves exact fleet/workspace/harness/window identities independently of the display label or supplied pass', async () => {
    const resolve = vi.fn(async () => ({ verdict: 'fail' as const, detail: 'measured drift', value: 7,
      evidenceRefs: ['source:one', 'source:two'] }));
    install(resolve);
    for (const [workspaceId, harnessSlug, ref, windowStart] of [
      ['ws', 'papercusp', 'fleet-a', subject.windowStart], ['other', 'papercusp', 'fleet-a', subject.windowStart],
      ['ws', 'other', 'fleet-a', subject.windowStart], ['ws', 'papercusp', 'fleet-b', '2026-10-01T12:00:00Z'],
    ]) {
      const requestSubject = { ...subject, ref: ref!, windowStart: windowStart!, label: 'fleet-a' };
      const snapshots = await resolveScorecardInstrumentSnapshots({
        rubric: { ...rubric, workspaceId, subjectHarnessSlug: harnessSlug },
        subject: requestSubject,
        supplied: { [key]: { verdict: 'pass', measuredAt: new Date(now()).toISOString(), provenance: 'platform-computed' } },
      }, { now });
      expect(resolve).toHaveBeenLastCalledWith({ workspaceId, harnessSlug, windowStart, windowEnd: subject.windowEnd,
        subject: { kind: 'fleet', ref } });
      expect(snapshots?.[key]).toMatchObject({ verdict: 'fail', provenance: 'platform-computed',
        value: { quantity: 7, unit: 'count', evidenceRefs: ['source:one', 'source:two'] } });
    }
    expect(resolve).toHaveBeenCalledTimes(4);
  });

  it.each([
    { workspaceId: '', subjectHarnessSlug: 'papercusp', subject },
    { workspaceId: '*', subjectHarnessSlug: 'papercusp', subject },
    { workspaceId: 'ws', subjectHarnessSlug: '', subject },
    { workspaceId: 'ws', subjectHarnessSlug: '*', subject },
    { workspaceId: 'ws', subjectHarnessSlug: 'papercusp', subject: { ...subject, windowEnd: subject.windowStart } },
    { workspaceId: 'ws', subjectHarnessSlug: 'papercusp', subject: { ...subject, windowStart: 'invalid' } },
    { workspaceId: 'ws', subjectHarnessSlug: 'papercusp', subject: { ...subject, windowEnd: '2026-10-04T00:00:00Z' } },
  ])('does not query incomplete scope or an invalid/unfinished window: %j', async input => {
    const resolve = vi.fn();
    install(resolve);
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric: { ...rubric,
      workspaceId: input.workspaceId, subjectHarnessSlug: input.subjectHarnessSlug }, subject: input.subject }, { now });
    expect(resolve).not.toHaveBeenCalled();
    expect(snapshots?.[key]?.verdict).toBe('unknown');
  });

  it('preserves an unavailable measurement as unknown and never retains a supplied healthy result', async () => {
    install(async () => { throw new Error('source unavailable'); });
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject,
      supplied: { [key]: { verdict: 'pass', measuredAt: new Date(now()).toISOString(), provenance: 'platform-computed' } },
    }, { now });
    expect(snapshots?.[key]).toMatchObject({ verdict: 'unknown', provenance: 'platform-computed',
      value: { reason: expect.stringContaining('source unavailable') } });
  });

  it('does not attach a quantity unit to a verdict-only result', async () => {
    install(async () => ({ verdict: 'pass', detail: 'all measured predicates pass' }));
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject }, { now });
    expect(snapshots?.[key]?.value).not.toHaveProperty('quantity');
    expect(snapshots?.[key]?.value).not.toHaveProperty('unit');
  });
});
