// @vitest-environment node
/**
 * agent-question-gate — B-10 (queen-autonomous-execution P-041/P-045) unit cover.
 * The EXECUTION seam: detect the autonomous caller, classify via the injectable
 * gate (default owner Queue), open a routable card-linked escalation, and prove the
 * back-edge resolves the live card (the in-turn resume). Uses the real card
 * correlator + the in-memory coord log (same harness as inbox-durable-escalation).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { configureCoordLog, resetCoordLog } from '../log';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { registerCard, _resetCardCorrelatorForTests } from '@papercusp/agent-mcp';
import { getEscalation } from '../escalations';
import { unblockLinkedCard } from '../card-link';
import type { AgentIdentity, IdentitySource } from '../identity';
import {
  AGENT_CARD_TIMEOUT_MS,
  AGENT_QUESTION_CATEGORY,
  classifyAgentQuestion,
  configureAgentQuestionGate,
  isAutonomousAgent,
  openAgentQuestionEscalation,
  resetAgentQuestionGate,
  routeAgentQuestion,
} from '../agent-question-gate';

const idOf = (source: IdentitySource): AgentIdentity => ({
  ownerId: `owner-${source}`,
  ownerLabel: source,
  source,
  workspaceId: 'ws-1',
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

const baseInput = (cardCorrelationId: string) => ({
  identity: idOf('fleet-spawn'),
  question: 'pick A or B?',
  options: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ],
  cardCorrelationId,
  cardWorkspaceId: 'ws-1',
});

beforeEach(() => {
  configureCoordLog(new InMemoryCoordLog());
  _resetCardCorrelatorForTests();
  resetAgentQuestionGate();
});
afterEach(() => {
  resetCoordLog();
  _resetCardCorrelatorForTests();
  resetAgentQuestionGate();
});

describe('isAutonomousAgent', () => {
  it('is true for a fleet bee and an invoke-route signed-spawn (no human at the card)', () => {
    expect(isAutonomousAgent(idOf('fleet-spawn'))).toBe(true);
    expect(isAutonomousAgent(idOf('signed-spawn'))).toBe(true);
  });
  it('is false for every interactive / operator tier (a human is watching the card)', () => {
    for (const s of ['power-user-token', 'omp-hook-session', 'static-client', 'principal'] as IdentitySource[]) {
      expect(isAutonomousAgent(idOf(s))).toBe(false);
    }
  });
});

describe('classifyAgentQuestion (the injectable gate)', () => {
  it('defaults to the owner Queue with the bounded timeout (D-007: no auto rung until armed)', () => {
    const r = classifyAgentQuestion({ identity: idOf('fleet-spawn'), question: 'q', options: [] });
    expect(r).toEqual({ rung: 'owner-queue', timeoutMs: AGENT_CARD_TIMEOUT_MS });
  });

  it('honors an injected classifier (autonomy-policy composes, it does not fork)', () => {
    configureAgentQuestionGate(() => ({ rung: 'queen', timeoutMs: 1234 }));
    expect(classifyAgentQuestion({ identity: idOf('fleet-spawn'), question: 'q', options: [] }))
      .toEqual({ rung: 'queen', timeoutMs: 1234 });
  });

  it('falls safe to the owner Queue when the injected gate throws', () => {
    configureAgentQuestionGate(() => {
      throw new Error('classifier blew up');
    });
    expect(classifyAgentQuestion({ identity: idOf('fleet-spawn'), question: 'q', options: [] }))
      .toEqual({ rung: 'owner-queue', timeoutMs: AGENT_CARD_TIMEOUT_MS });
  });

  it('ignores a non-positive timeout override and uses the bounded default', () => {
    configureAgentQuestionGate(() => ({ rung: 'peer-vote', timeoutMs: 0 }));
    expect(classifyAgentQuestion({ identity: idOf('fleet-spawn'), question: 'q', options: [] }))
      .toEqual({ rung: 'peer-vote', timeoutMs: AGENT_CARD_TIMEOUT_MS });
  });
});

describe('openAgentQuestionEscalation', () => {
  it('writes a routable, card-linked escalation tagged as an agent-question', async () => {
    const rec = await openAgentQuestionEscalation(idOf('fleet-spawn'), baseInput('corr-1'), 'owner-queue');
    expect(rec).not.toBeNull();
    const round = (await getEscalation(rec!.msg_id)) as Record<string, unknown> | null;
    expect(round?.severity).toBe('question');
    expect(round?.category).toBe(AGENT_QUESTION_CATEGORY);
    expect(round?.autonomous).toBe(true);
    expect(round?.rung).toBe('owner-queue');
    expect(round?.cardCorrelationId).toBe('corr-1');
    expect(round?.cardWorkspaceId).toBe('ws-1');
    // Routed to the owner inbox / Queue (the un-armed default destination).
    expect(round?.to).toEqual(['human']);
  });
});

describe('routeAgentQuestion (classify + open) and the P-045 back-edge', () => {
  it('routes to owner-queue by default and the routed escalation unblocks the live card', async () => {
    // The bee is blocked on a live card…
    const { correlationId, result } = registerCard({ workspaceId: 'ws-1', runId: 'run-1', spec: cardSpec() });

    // …routing opens the durable, linked escalation.
    const routed = await routeAgentQuestion(idOf('fleet-spawn'), baseInput(correlationId));
    expect(routed.rung).toBe('owner-queue');
    expect(routed.timeoutMs).toBe(AGENT_CARD_TIMEOUT_MS);
    expect(routed.escalation).not.toBeNull();

    // Whoever answers the escalation (coord:resolve → unblockLinkedCard) resolves
    // the SAME card → the bee resumes in-turn with the pick.
    const folded = (await getEscalation(routed.escalation!.msg_id)) as Record<string, unknown>;
    const out = unblockLinkedCard(folded, 'b');
    expect(out.unblocked).toBe(true);
    await expect(result).resolves.toEqual({ action: 'submit', payload: { picks: ['b'] } });
  });

  it('an injected rung is stamped onto the routed escalation', async () => {
    configureAgentQuestionGate(() => ({ rung: 'queen' }));
    const routed = await routeAgentQuestion(idOf('fleet-spawn'), baseInput('corr-q'));
    expect(routed.rung).toBe('queen');
    const folded = (await getEscalation(routed.escalation!.msg_id)) as Record<string, unknown>;
    expect(folded.rung).toBe('queen');
  });
});
