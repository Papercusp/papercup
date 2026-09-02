/**
 * semantic-dedup-probe-alarm.test — EI-22170937574367219: the missing
 * publisher for "the semantic dedup probe just went unavailable". Covers:
 * (1) the VITEST no-op guard (so the ~15 existing dedup-gate test cases that
 * already drive this path via a null-mocked findSemanticDupes need no new
 * mocking), and (2) the real path's escalation shape once VITEST is cleared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const escalationMocks = vi.hoisted(() => ({ open: vi.fn(async () => ({ msg_id: 'esc-1' })) }));
vi.mock('../coordination/escalations', () => ({ openEscalation: escalationMocks.open }));

import { reportSemanticDedupProbeUnavailable } from './semantic-dedup-probe-alarm';

const originalVitest = process.env.VITEST;

describe('reportSemanticDedupProbeUnavailable', () => {
  beforeEach(() => {
    escalationMocks.open.mockClear();
  });
  afterEach(() => {
    if (originalVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = originalVitest;
  });

  it('is a NO-OP under vitest — never calls openEscalation (protects the ~15 dedup-gate tests)', async () => {
    expect(process.env.VITEST).toBeTruthy(); // the ambient contract this test relies on
    await reportSemanticDedupProbeUnavailable({ harnessSlug: 'papercusp' });
    expect(escalationMocks.open).not.toHaveBeenCalled();
  });

  it('opens a deduplicated advisory escalation once VITEST is cleared', async () => {
    delete process.env.VITEST;
    await reportSemanticDedupProbeUnavailable({ harnessSlug: 'papercusp' });
    expect(escalationMocks.open).toHaveBeenCalledTimes(1);
    const [identity, input] = escalationMocks.open.mock.calls[0] as unknown as [
      { ownerId: string },
      { severity: string; summary: string; meta?: { dedupKind?: string; subjectSignature?: string } },
    ];
    expect(identity.ownerId).toBe('system:semantic-dedup-probe-alarm');
    expect(input.severity).toBe('advisory');
    expect(input.summary).toContain('dedup_unavailable');
    expect(input.meta).toEqual({
      dedupKind: 'semantic-dedup-probe-unavailable',
      subjectSignature: 'work-items-create-goal-gate',
    });
  });

  it('never throws when openEscalation itself fails (fire-and-forget contract)', async () => {
    delete process.env.VITEST;
    escalationMocks.open.mockRejectedValueOnce(new Error('pg down'));
    await expect(reportSemanticDedupProbeUnavailable({})).resolves.toBeUndefined();
  });

  it('omits the harness clause from the body when no harnessSlug is known', async () => {
    delete process.env.VITEST;
    await reportSemanticDedupProbeUnavailable({});
    const input = (escalationMocks.open.mock.calls[0] as unknown as [unknown, { body: string }])[1];
    expect(input.body).not.toContain('in harness');
  });
});
