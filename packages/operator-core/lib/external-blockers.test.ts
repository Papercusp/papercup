import { describe, expect, it } from 'vitest';
import {
  applyExternalBlockerUpdate,
  activeExternalBlockers,
  externalBlockerCapabilityPolicy,
  readExternalBlockers,
  updateExternalBlockerHistory,
} from './external-blockers';

const T1 = '2026-07-13T08:00:00.000Z';
const T2 = '2026-07-13T09:00:00.000Z';

describe('typed external blocker history', () => {
  it('adds a typed event blocker without touching sibling payload/dependency history', () => {
    const payload = { plan_item: { item_id: 'P-008' }, internalDependencyHistory: ['WI-1'] };
    const out = updateExternalBlockerHistory(
      payload,
      {
        kind: 'event',
        capability: 'live-dependency',
        ref: 'deploy:ready:staging',
        summary: 'staging deploy must finish',
        nextVerb: 'events:await',
      },
      'su-a',
      T1,
    );
    expect(out.changed).toBe(true);
    expect(out.blockers).toEqual([
      expect.objectContaining({
        kind: 'event',
        capability: 'live-dependency',
        ref: 'deploy:ready:staging',
        status: 'active',
        createdAt: T1,
        createdBy: 'su-a',
      }),
    ]);
    expect(payload).toEqual({ plan_item: { item_id: 'P-008' }, internalDependencyHistory: ['WI-1'] });
  });

  it('clears in place, preserving the blocker as history', () => {
    const active = updateExternalBlockerHistory(
      {},
      { kind: 'gate', ref: 'release-green', summary: 'release gate red' },
      'su-a',
      T1,
    );
    const cleared = updateExternalBlockerHistory(
      { externalBlockers: active.blockers },
      { kind: 'gate', ref: 'release-green', clear: true, evidence: 'gate rerun green' },
      'su-b',
      T2,
    );
    expect(cleared.blockers).toEqual([
      expect.objectContaining({
        status: 'cleared',
        createdAt: T1,
        clearedAt: T2,
        clearedBy: 'su-b',
        evidence: 'gate rerun green',
      }),
    ]);
    expect(activeExternalBlockers({ externalBlockers: cleared.blockers })).toEqual([]);
  });

  it('is defensive against malformed federated payload rows', () => {
    expect(readExternalBlockers({ externalBlockers: [null, {}, { kind: 'event' }] })).toEqual([]);
    expect(readExternalBlockers(null)).toEqual([]);
  });

  it('infers a conservative capability for legacy rows while marking provenance', () => {
    const legacy = {
      kind: 'human',
      ref: 'owner-choice',
      summary: 'choose a direction',
      status: 'active',
      createdAt: T1,
      createdBy: 'su-a',
      updatedAt: T1,
    };
    expect(readExternalBlockers({ externalBlockers: [legacy] })).toEqual([
      expect.objectContaining({
        capability: 'product-decision',
        capabilitySource: 'legacy-inferred',
      }),
    ]);
  });

  it('mechanically clears standing approval under AUTO but not missing physical capability', () => {
    const approval = applyExternalBlockerUpdate(
      {},
      { kind: 'human', capability: 'approval-auto-clearable', ref: 'deploy-approval' },
      'su-auto',
      { autoAuthority: true },
      T1,
    );
    expect(approval.autoCleared).toBe(true);
    expect(approval.blockers).toEqual([
      expect.objectContaining({ status: 'cleared', capability: 'approval-auto-clearable' }),
    ]);

    const device = applyExternalBlockerUpdate(
      {},
      { kind: 'human', capability: 'physical-device', ref: 'live-mic' },
      'su-auto',
      { autoAuthority: true },
      T1,
    );
    expect(device.autoCleared).toBe(false);
    expect(device.blockers[0]).toMatchObject({ status: 'active', capability: 'physical-device' });
    expect(externalBlockerCapabilityPolicy('physical-device')).toMatchObject({
      autoClearable: false,
      requiresOwnerCapability: true,
      resolutionOwner: 'device-holder',
    });
  });
});
