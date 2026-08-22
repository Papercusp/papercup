import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  openEscalation: vi.fn(),
  armEscalationRequesterInterest: vi.fn(),
}));

vi.mock('../identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'requester-1', ownerLabel: 'Requester 1' }),
}));
vi.mock('../escalations', () => ({
  openEscalation: h.openEscalation,
  armEscalationRequesterInterest: h.armEscalationRequesterInterest,
}));

import tool from './escalate';

const handle = {
  event_keys: ['escalation:resolved:esc-1'],
  await_ids: [51],
  cancel: { tool: 'events:cancel' as const, args: { await_ids: [51] } },
  handle_note: 'captured requester wake handle',
};

beforeEach(() => {
  h.openEscalation.mockReset().mockResolvedValue({ msg_id: 'esc-1', ts: '2026-08-21T00:00:00.000Z' });
  h.armEscalationRequesterInterest.mockReset().mockResolvedValue(handle);
});

describe('coord:escalate requester interest handle (P-024)', () => {
  it('arms the concrete resolution edge and returns its cancel handle', async () => {
    const out = await (tool as any).handler({ severity: 'question', summary: 'Choose a route' }, {});
    const body = JSON.parse(out.content[0].text);
    expect(h.armEscalationRequesterInterest).toHaveBeenCalledWith('requester-1', 'esc-1');
    expect(body).toMatchObject({ ok: true, msg_id: 'esc-1', interest_watch: handle });
  });
});
