import { describe, expect, it, vi } from 'vitest';

const scheduled = vi.hoisted(() => [] as { name?: string; crontab?: string }[]);

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    registerWorkflow: (fn: unknown) => fn,
    registerScheduled: (_fn: unknown, cfg: { name?: string; crontab?: string }) => {
      scheduled.push(cfg);
    },
    runStep: vi.fn(),
  },
}));

import { WORKSPACE_HOST_STANDING_HEALTH_CRONTAB } from '../workspace-host/standing-health';
import { WORKSPACE_HOST_HEALTH_WORKFLOW_NAME, workspaceHostStandingHealthSummary } from './workspace-host-health-workflow';

describe('workspace-host standing health workflow', () => {
  it('is registered as a 15-minute DBOS schedule under its workflow name', () => {
    expect(WORKSPACE_HOST_STANDING_HEALTH_CRONTAB).toBe('*/15 * * * *');
    expect(scheduled).toContainEqual({
      name: WORKSPACE_HOST_HEALTH_WORKFLOW_NAME,
      crontab: WORKSPACE_HOST_STANDING_HEALTH_CRONTAB,
    });
  });

  it('stays quiet when every probed host is healthy', () => {
    expect(
      workspaceHostStandingHealthSummary({
        controllerId: 'c',
        outcomes: [
          { kind: 'attested', workspaceId: 'w', hostId: 'h1', status: 'healthy', checks: [] },
          { kind: 'skipped-fresh', workspaceId: 'w', hostId: 'h2', attestedAt: '2026-10-01T17:58:00.000Z' },
        ],
      }),
    ).toBeNull();
  });

  it('names every host that is not healthy or whose attestation was not recorded', () => {
    const summary = workspaceHostStandingHealthSummary({
      controllerId: 'c',
      outcomes: [
        { kind: 'attested', workspaceId: 'w', hostId: 'h1', status: 'healthy', checks: [] },
        { kind: 'attested', workspaceId: 'w', hostId: 'h2', status: 'unreachable', checks: [] },
        { kind: 'record-failed', workspaceId: 'w', hostId: 'h3', error: 'connection closed' },
      ],
    });
    expect(summary).toBe(
      '[workspace-host-health] c: 2 attested, 1 not healthy, 1 not recorded | w/h2=unreachable | w/h3 record failed: connection closed',
    );
  });
});
