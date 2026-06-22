/**
 * handoffs — unit coverage for the operator-host handoff adapter (agent → agent
 * work handoffs). The per-event I/O lives behind the coordLog seam (mocked here);
 * the fold lives in @papercusp/coordination/core (real). What's tested is the
 * ADAPTER: the immutable sibling-event construction + ROUTING — an acceptance /
 * expiry / re-ping must address the OFFERER (target.from), carry related_msg_id +
 * plan_slug, and a missing target must be a null no-op (never a spurious event).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const log = vi.hoisted(() => ({
  coordLog: { putEvent: vi.fn(), getEvent: vi.fn(), readEvents: vi.fn() },
}));
vi.mock('./log', () => log);

import { openHandoff, acceptHandoff, expireHandoff, repingHandoff, getHandoff } from './handoffs';
import type { HandoffRecord } from '@papercusp/coordination/core';
import type { AgentIdentity } from './identity';

const identity = { ownerId: 'me-owner' } as AgentIdentity;
const target: HandoffRecord = {
  ts: '2026-06-22T00:00:00.000Z',
  msg_id: 'h-1',
  from: 'offerer',
  to: ['me-owner'],
  kind: 'handoff',
  plan_slug: 'plan-x',
  summary: 'take over X',
};

beforeEach(() => {
  log.coordLog.putEvent.mockReset().mockResolvedValue(undefined);
  log.coordLog.getEvent.mockReset();
  log.coordLog.readEvents.mockReset();
});

describe('openHandoff', () => {
  it('writes a handoff event with the offerer + recipients, including only the provided optional fields', async () => {
    const rec = await openHandoff(identity, { to: ['peer-a'], summary: 'do X', plan_slug: 'p', next_action: 'edit foo' });
    expect(rec).toMatchObject({
      kind: 'handoff',
      from: 'me-owner',
      to: ['peer-a'],
      summary: 'do X',
      plan_slug: 'p',
      next_action: 'edit foo',
    });
    expect('body' in rec).toBe(false); // omitted optionals stay absent
    expect('files_modified' in rec).toBe(false);
    expect('commit' in rec).toBe(false);
    expect(log.coordLog.putEvent).toHaveBeenCalledWith('handoffs', rec.msg_id, rec);
  });
});

describe('acceptHandoff', () => {
  it('returns null when the target handoff is absent (no write)', async () => {
    log.coordLog.getEvent.mockResolvedValue(null);
    expect(await acceptHandoff(identity, 'missing')).toBeNull();
    expect(log.coordLog.putEvent).not.toHaveBeenCalled();
  });

  it('writes a handoff_accepted sibling addressed to the OFFERER, carrying related_msg_id + plan_slug', async () => {
    log.coordLog.getEvent.mockResolvedValue(target);
    const rec = await acceptHandoff(identity, 'h-1', 'on it');
    expect(rec).toMatchObject({
      kind: 'handoff_accepted',
      from: 'me-owner',
      to: ['offerer'], // back to the offerer — NOT the original recipients
      related_msg_id: 'h-1',
      plan_slug: 'plan-x',
      summary: 'on it',
    });
    expect(log.coordLog.putEvent).toHaveBeenCalledWith('handoffs', rec!.msg_id, rec);
  });

  it('defaults the acceptance summary when no note is given', async () => {
    log.coordLog.getEvent.mockResolvedValue(target);
    const rec = await acceptHandoff(identity, 'h-1');
    expect(rec!.summary).toBe('accepted handoff from offerer');
  });
});

describe('expireHandoff + repingHandoff (system reconcile siblings)', () => {
  it('expireHandoff writes a handoff_expired sibling from the reconcile owner to the offerer', async () => {
    log.coordLog.getEvent.mockResolvedValue(target);
    const rec = await expireHandoff('h-1', { by: 'system-reconcile' });
    expect(rec).toMatchObject({
      kind: 'handoff_expired',
      from: 'system-reconcile',
      to: ['offerer'],
      related_msg_id: 'h-1',
      plan_slug: 'plan-x',
    });
  });

  it('repingHandoff writes a handoff_repinged sibling from the reconcile owner to the offerer', async () => {
    log.coordLog.getEvent.mockResolvedValue(target);
    const rec = await repingHandoff('h-1', { by: 'system-reconcile', note: 'still waiting' });
    expect(rec).toMatchObject({
      kind: 'handoff_repinged',
      from: 'system-reconcile',
      to: ['offerer'],
      related_msg_id: 'h-1',
      summary: 'still waiting',
    });
  });

  it('both return null when the target handoff is absent', async () => {
    log.coordLog.getEvent.mockResolvedValue(null);
    expect(await expireHandoff('x', { by: 's' })).toBeNull();
    expect(await repingHandoff('x', { by: 's' })).toBeNull();
  });
});

describe('getHandoff', () => {
  it('returns the record when it is a valid handoff', async () => {
    log.coordLog.getEvent.mockResolvedValue(target);
    expect(await getHandoff('h-1')).toEqual(target);
  });

  it('returns null for a missing or non-handoff record', async () => {
    log.coordLog.getEvent.mockResolvedValue(null);
    expect(await getHandoff('x')).toBeNull();
    log.coordLog.getEvent.mockResolvedValue({ kind: 'message', foo: 1 }); // not a handoff record
    expect(await getHandoff('y')).toBeNull();
  });
});
