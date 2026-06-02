/**
 * resolve-tool.test.ts — plan harness-test-coverage-for-launch P-018 (residual).
 *
 * The coord:resolve TOOL handler: wraps resolveEscalation, resolves identity,
 * and on success unblocks any linked live card. resolveEscalation itself is
 * covered (escalations-handoffs.test.ts); this pins the handler's envelopes
 * (ok / not_found / already_resolved) and the card-unblock side effect.
 * In-memory coordLog; identity + card-link mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { configureCoordLog, resetCoordLog } from '../log';
import { openEscalation } from '../escalations';
import type { AgentIdentity } from '../identity';

vi.mock('../identity', () => ({
  resolveAgentIdentity: (): AgentIdentity => ({
    ownerId: 'human',
    ownerLabel: 'human',
    source: 'omp-hook-session',
    workspaceId: 'default',
    userId: null,
  }),
}));
vi.mock('../card-link', () => ({ unblockLinkedCard: vi.fn() }));

import resolveTool from '../tools/resolve';
import { unblockLinkedCard } from '../card-link';

const HUMAN: AgentIdentity = {
  ownerId: 'human',
  ownerLabel: 'human',
  source: 'omp-hook-session',
  workspaceId: 'default',
  userId: null,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (args: Record<string, unknown>) => resolveTool.handler(args as any, {} as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parse = (res: any) => JSON.parse(res.content[0].text);

beforeEach(() => {
  configureCoordLog(new InMemoryCoordLog());
  vi.mocked(unblockLinkedCard).mockReset();
});
afterEach(() => resetCoordLog());

describe('coord:resolve handler', () => {
  it('resolves an open escalation and unblocks its linked card', async () => {
    const e = await openEscalation(HUMAN, { severity: 'question', summary: 'A or B?' });
    const res = await run({ msg_id: e.msg_id, choice: 'go', note: 'approved' });

    const body = parse(res);
    expect(res.isError).toBeFalsy();
    expect(body.ok).toBe(true);
    expect(body.escalation.resolved.choice).toBe('go');
    expect(body.escalation.resolved.by).toBe('human');
    // Side effect: a linked live card (if any) is unblocked with the choice.
    expect(unblockLinkedCard).toHaveBeenCalledTimes(1);
    expect(vi.mocked(unblockLinkedCard).mock.calls[0][1]).toBe('go');
  });

  it('returns not_found (isError) for an unknown msg_id and does not unblock', async () => {
    const res = await run({ msg_id: 'never', choice: 'x' });
    const body = parse(res);
    expect(res.isError).toBe(true);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not_found');
    expect(unblockLinkedCard).not.toHaveBeenCalled();
  });

  it('returns already_resolved (isError) on a second resolve and does not re-unblock', async () => {
    const e = await openEscalation(HUMAN, { severity: 'blocker', summary: 'need a call' });
    await run({ msg_id: e.msg_id, choice: 'first' });
    vi.mocked(unblockLinkedCard).mockReset();

    const res = await run({ msg_id: e.msg_id, choice: 'second' });
    const body = parse(res);
    expect(res.isError).toBe(true);
    expect(body.error).toBe('already_resolved');
    expect(unblockLinkedCard).not.toHaveBeenCalled();
  });
});
