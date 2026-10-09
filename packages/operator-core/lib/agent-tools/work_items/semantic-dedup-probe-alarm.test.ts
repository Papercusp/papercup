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

import {
  reportDedupCoverageDegraded,
  reportSemanticDedupProbeUnavailable,
} from './semantic-dedup-probe-alarm';

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
    await reportDedupCoverageDegraded({
      source: 'improvements:capture',
      harnessSlug: 'papercusp',
      coverage: { lexical: 'unavailable', semantic: 'unavailable', degraded: true },
    });
    expect(escalationMocks.open).not.toHaveBeenCalled();
  });

  it('opens a deduplicated advisory escalation with source and achieved coverage', async () => {
    delete process.env.VITEST;
    await reportDedupCoverageDegraded({
      source: 'improvements:capture',
      harnessSlug: 'papercusp',
      coverage: { lexical: 'unavailable', semantic: 'unavailable', degraded: true },
    });
    expect(escalationMocks.open).toHaveBeenCalledTimes(1);
    const [identity, input] = escalationMocks.open.mock.calls[0] as unknown as [
      { ownerId: string },
      { severity: string; summary: string; body: string; meta?: { dedupKind?: string; subjectSignature?: string } },
    ];
    expect(identity.ownerId).toBe('system:semantic-dedup-probe-alarm');
    expect(input.severity).toBe('advisory');
    expect(input.summary).toContain('coverage is incomplete');
    expect(input.body).toContain("from improvements:capture in harness 'papercusp'");
    expect(input.body).toContain('lexical=unavailable, semantic=unavailable');
    expect(input.meta).toEqual({
      dedupKind: 'work-item-dedup-coverage-degraded',
      subjectSignature: 'papercusp-work-item-dedup',
    });
  });

  it('keeps the legacy work_items:create alarm mapped onto the shared coverage alert', async () => {
    delete process.env.VITEST;
    await reportSemanticDedupProbeUnavailable({ harnessSlug: 'papercusp' });
    const input = (escalationMocks.open.mock.calls[0] as unknown as [unknown, { body: string }])[1];
    expect(input.body).toContain('from work_items:create');
    expect(input.body).toContain('semantic=unavailable');
  });

  it('never throws when openEscalation itself fails (fire-and-forget contract)', async () => {
    delete process.env.VITEST;
    escalationMocks.open.mockRejectedValueOnce(new Error('pg down'));
    await expect(reportDedupCoverageDegraded({ source: 'improvements:capture' })).resolves.toBeUndefined();
  });

  it('omits the harness clause from the body when no harnessSlug is known', async () => {
    delete process.env.VITEST;
    await reportDedupCoverageDegraded({ source: 'improvements:capture' });
    const input = (escalationMocks.open.mock.calls[0] as unknown as [unknown, { body: string }])[1];
    expect(input.body).not.toContain('in harness');
  });
});
