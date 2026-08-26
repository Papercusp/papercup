import { describe, expect, it, vi } from 'vitest';
import {
  appendFleetEventActivity,
  FLEET_ACTIVITY_TRANSITIONS,
  fleetEventActivityRecord,
} from './fleet-event-activity';

describe('fleet event activity projection', () => {
  it.each(FLEET_ACTIVITY_TRANSITIONS)('projects fleet:%s without inventing a transport', (transition) => {
    const payload = {
      fleetSlug: 'pui-cockpit',
      transition,
      agentId: 'su-a',
      harness: 'papercusp',
      id: 'WI-7',
    };
    const row = fleetEventActivityRecord({
      eventKey: `fleet:${transition}:pui-cockpit`,
      payload,
      summary: `observed ${transition}`,
      workspaceId: 'ws-1',
    });

    expect(row).toMatchObject({
      owner: 'su-a',
      agent: 'fleet',
      scope: 'papercusp',
      kind: 'lifecycle',
      toolName: 'fleet:event',
      phase: 'post',
      summary: `observed ${transition}`,
      workspaceId: 'ws-1',
      detail: {
        eventKey: `fleet:${transition}:pui-cockpit`,
        fleetSlug: 'pui-cockpit',
        transition,
        payload,
      },
    });
  });

  it('keeps non-fleet and non-tape events out of the activity firehose', () => {
    expect(
      fleetEventActivityRecord({
        eventKey: 'work-item:done:WI-7',
        workspaceId: 'ws-1',
      }),
    ).toBeNull();
    expect(
      fleetEventActivityRecord({
        eventKey: 'fleet:member-stalled:pui-cockpit',
        workspaceId: 'ws-1',
      }),
    ).toBeNull();
  });

  it('attributes item events to their actor and fleet-only events to the fleet', () => {
    expect(
      fleetEventActivityRecord({
        eventKey: 'fleet:claim-released:pui-cockpit',
        payload: { priorAssignee: 'su-old' },
        workspaceId: 'ws-1',
      })?.owner,
    ).toBe('su-old');
    expect(
      fleetEventActivityRecord({
        eventKey: 'fleet:drained:pui-cockpit',
        payload: { fleetSlug: 'pui-cockpit' },
        workspaceId: 'ws-1',
      })?.owner,
    ).toBe('fleet:pui-cockpit');
  });

  it('is fail-soft when activity persistence is unavailable', async () => {
    const log = vi.fn();
    const append = vi.fn(async () => {
      throw new Error('pg unavailable');
    });
    await expect(
      appendFleetEventActivity(
        {
          eventKey: 'fleet:member-dead:pui-cockpit',
          payload: { fleetSlug: 'pui-cockpit', agentId: 'su-a' },
          workspaceId: 'ws-1',
        },
        { append, log },
      ),
    ).resolves.toBe(false);
    expect(append).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('pg unavailable'));
  });
});
