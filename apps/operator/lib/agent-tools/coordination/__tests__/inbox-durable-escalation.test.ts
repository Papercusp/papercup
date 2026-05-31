// @vitest-environment node
/**
 * inbox-cards-unification Phase D — the inbox ⇄ live-card convergence
 * (P-033 link persistence + P-035 unblock). This is the cross-channel coupling
 * that can't be exercised by a live agent headless, so it's covered here with
 * the real card correlator + the in-memory coord log.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { configureCoordLog, resetCoordLog } from '../log';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { registerCard, _resetCardCorrelatorForTests } from '@papercusp/agent-mcp';
import { openEscalation, getEscalation } from '../escalations';
import { unblockLinkedCard } from '../card-link';
import type { AgentIdentity } from '../identity';

const id = (ownerId: string): AgentIdentity => ({
  ownerId,
  ownerLabel: ownerId,
  source: 'omp-hook-session',
  workspaceId: 'default',
  userId: null,
});

const choiceSchema = z.object({ picks: z.array(z.string()).min(1) });
const cardSpec = () => ({
  prompt: 'pick',
  dataSchema: choiceSchema,
  presentation: {
    kind: 'radio' as const,
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
  },
});

beforeEach(() => {
  configureCoordLog(new InMemoryCoordLog());
  _resetCardCorrelatorForTests();
});
afterEach(() => {
  resetCoordLog();
  _resetCardCorrelatorForTests();
});

describe('Phase D — durable escalation ⇄ live card', () => {
  it('P-033: openEscalation persists the card link (round-trips through the store)', async () => {
    const rec = await openEscalation(id('A'), {
      severity: 'question',
      summary: 'pick A or B?',
      options: [{ id: 'a', label: 'A' }],
      meta: { cardCorrelationId: 'corr-1', cardWorkspaceId: 'ws-1' },
    });
    const round = (await getEscalation(rec.msg_id)) as Record<string, unknown> | null;
    expect(round?.cardCorrelationId).toBe('corr-1');
    expect(round?.cardWorkspaceId).toBe('ws-1');
  });

  it('P-035: resolving a linked escalation unblocks the live card with the choice', async () => {
    const { correlationId, result } = registerCard({
      workspaceId: 'ws-1',
      runId: 'run-1',
      spec: cardSpec(),
    });
    const rec = await openEscalation(id('A'), {
      severity: 'question',
      summary: 'pick A or B?',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      meta: { cardCorrelationId: correlationId, cardWorkspaceId: 'ws-1' },
    });
    const folded = (await getEscalation(rec.msg_id)) as Record<string, unknown>;

    const out = unblockLinkedCard(folded, 'b');
    expect(out.unblocked).toBe(true);
    // The blocked agent's askUser promise resolves with the picked option.
    await expect(result).resolves.toEqual({ action: 'submit', payload: { picks: ['b'] } });
  });

  it('no-op when the escalation has no card link (the flag-off path)', () => {
    expect(unblockLinkedCard({}, 'a')).toEqual({ unblocked: false });
  });

  it('cross-workspace guard: a mismatched cardWorkspaceId does NOT unblock the card', async () => {
    const { correlationId, result } = registerCard({
      workspaceId: 'ws-A',
      runId: 'run-2',
      spec: cardSpec(),
    });
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    const out = unblockLinkedCard({ cardCorrelationId: correlationId, cardWorkspaceId: 'ws-B' }, 'a');
    expect(out.unblocked).toBe(false);
    await new Promise((res) => setTimeout(res, 5));
    expect(settled).toBe(false); // card stays pending
  });
});
