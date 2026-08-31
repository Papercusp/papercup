import { describe, expect, it, vi } from 'vitest';
import {
  VoiceTurnRoutingError,
  createVoiceTurnRouter,
  type VoiceTurnRouterDependencies,
  type VoiceTurnRoutingInput,
} from './voice-turn-router';
import type { VoiceContextSources } from './voice-context-projection';

const baseTurn = (): Omit<VoiceTurnRoutingInput, 'resolvedPrincipal'> => ({
  workspaceId: 'workspace-1',
  turnId: 'turn-1',
  sequence: 0,
  occurredAt: '2026-08-31T16:00:00.000Z',
  transport: 'papercup-local',
  latencyClass: 'deliberative',
  transcript: 'What is next?',
});

function harness(over: Partial<VoiceTurnRouterDependencies> = {}) {
  const voiceContextSources: VoiceContextSources = {
    now: () => new Date('2026-08-31T16:00:01.000Z'),
    resolveOwnerVault: vi.fn(async () => ({ available: true as const, candidates: [] })),
    resolveCallerHistory: vi.fn(async () => ({ available: true as const, candidates: [] })),
  };
  const deps: VoiceTurnRouterDependencies = {
    getOrCreateActiveOperatorConversation: vi.fn(async () => ({ id: 'operator-active' })),
    getOrCreateCallConversation: vi.fn(async ({ callSessionId }) => ({ id: `call:${callSessionId}` })),
    resolveOwnerTools: vi.fn(async () => ['calendar:list', 'email:draft']),
    voiceContextSources,
    ...over,
  };
  return { deps, route: createVoiceTurnRouter(deps) };
}

const owner = {
  kind: 'owner',
  subjectId: 'owner-1',
  authenticated: true,
  authoritySource: 'owner-session',
} as const;

describe('voice-turn router policy', () => {
  it('keeps a local owner turn on the active operator conversation', async () => {
    const { deps, route } = harness();
    const result = await route({ ...baseTurn(), resolvedPrincipal: owner });

    expect(result.policy).toBe('owner');
    expect(result.turn.conversation).toEqual({
      kind: 'operator',
      id: 'operator-active',
      parentOperatorConversationId: null,
    });
    expect(result.turn.capabilities).toEqual({
      read: [
        'conversation-history', 'personal-memory', 'contacts', 'calendar', 'email',
        'caller-history', 'call-policy',
      ],
      write: ['conversation-turn', 'call-outcome', 'draft'],
      tools: ['calendar:list', 'email:draft'],
    });
    expect(deps.getOrCreateCallConversation).not.toHaveBeenCalled();
    expect(result.context).toMatchObject({
      version: 1,
      resolvedAt: '2026-08-31T16:00:01.000Z',
      principal: { kind: 'owner', subjectId: 'owner-1' },
    });
    expect(deps.voiceContextSources?.resolveOwnerVault).toHaveBeenCalledOnce();
  });

  it('links an authenticated owner phone call to the active operator conversation', async () => {
    const { route } = harness();
    const result = await route({
      ...baseTurn(),
      transport: 'phone-livekit',
      latencyClass: 'interactive',
      callSessionId: 'room-owner',
      resolvedPrincipal: owner,
    });
    expect(result.turn.conversation).toEqual({
      kind: 'phone-call',
      id: 'call:room-owner',
      parentOperatorConversationId: 'operator-active',
    });
  });

  it.each([
    {
      kind: 'guest' as const,
      principal: { kind: 'guest' as const, subjectId: 'invite-1', authenticated: true, authoritySource: 'invite' as const },
      read: ['call-policy'],
    },
    {
      kind: 'unknown' as const,
      principal: { kind: 'unknown' as const, subjectId: null, authenticated: false, authoritySource: 'unknown' as const },
      read: ['call-policy'],
    },
  ])('isolates a $kind principal in a restricted call conversation', async ({ principal, read }) => {
    const { deps, route } = harness();
    const result = await route({
      ...baseTurn(),
      callSessionId: `session-${principal.kind}`,
      resolvedPrincipal: principal,
    });
    expect(result.policy).toBe('restricted-call');
    expect(result.turn.conversation).toMatchObject({
      kind: 'phone-call',
      parentOperatorConversationId: null,
    });
    expect(result.turn.capabilities).toEqual({
      read,
      write: ['conversation-turn', 'call-outcome'],
      tools: [],
    });
    expect(deps.getOrCreateActiveOperatorConversation).not.toHaveBeenCalled();
    expect(deps.voiceContextSources?.resolveOwnerVault).not.toHaveBeenCalled();
  });

  it('L4 counterexample: client fields cannot elevate a caller into owner policy or conversation', async () => {
    const { deps, route } = harness();
    const malicious = {
      ...baseTurn(),
      callSessionId: 'caller-room',
      resolvedPrincipal: {
        kind: 'caller',
        subjectId: 'contact-44',
        authenticated: false,
        authoritySource: 'call-ledger',
      },
      principal: owner,
      capabilities: {
        read: ['calendar', 'email'],
        write: ['draft'],
        tools: ['*'],
      },
      conversation: {
        kind: 'operator',
        id: 'stolen-owner-thread',
        parentOperatorConversationId: null,
      },
      context: {
        version: 1,
        status: 'ready',
        sources: [{ capability: 'email', items: [{ text: 'stolen owner data' }] }],
      },
    } as VoiceTurnRoutingInput & Record<string, unknown>;

    const result = await route(malicious);
    expect(result.turn.principal.kind).toBe('caller');
    expect(result.turn.capabilities).toEqual({
      read: ['caller-history', 'call-policy'],
      write: ['conversation-turn', 'call-outcome'],
      tools: [],
    });
    expect(result.turn.capabilities.read).not.toContain('calendar');
    expect(result.turn.capabilities.read).not.toContain('email');
    expect(result.turn.conversation).toEqual({
      kind: 'phone-call',
      id: 'call:caller-room',
      parentOperatorConversationId: null,
    });
    expect(result.turn.conversation.parentOperatorConversationId).toBeNull();
    expect(deps.resolveOwnerTools).not.toHaveBeenCalled();
    expect(deps.getOrCreateActiveOperatorConversation).not.toHaveBeenCalled();
    expect(deps.getOrCreateCallConversation).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      callSessionId: 'caller-room',
      transport: 'papercup-local',
      principal: malicious.resolvedPrincipal,
    });
    expect(result.context.principal.kind).toBe('caller');
    expect(result.context.sources.find((source) => source.capability === 'email')).toMatchObject({
      status: 'denied',
      items: [],
    });
    expect(deps.voiceContextSources?.resolveOwnerVault).not.toHaveBeenCalled();
    expect(deps.voiceContextSources?.resolveCallerHistory).toHaveBeenCalledOnce();
  });

  it('keeps dispatch alive with an explicit degraded context when the owner vault fails', async () => {
    const { route } = harness({
      voiceContextSources: {
        now: () => new Date('2026-08-31T16:00:01.000Z'),
        resolveOwnerVault: vi.fn(async () => { throw new Error('vault unavailable'); }),
        resolveCallerHistory: vi.fn(async () => ({ available: true as const, candidates: [] })),
      },
    });

    const result = await route({ ...baseTurn(), resolvedPrincipal: owner });

    expect(result.turn.turnId).toBe('turn-1');
    expect(result.context.status).toBe('degraded');
    expect(result.context.sources.find((source) => source.capability === 'email')).toMatchObject({
      status: 'degraded',
      reason: 'source-unavailable',
      items: [],
    });
  });

  it('fails closed on an incompatible server-resolved authority source', async () => {
    const { route } = harness();
    await expect(route({
      ...baseTurn(),
      callSessionId: 'bad-caller',
      resolvedPrincipal: {
        kind: 'caller',
        subjectId: 'owner-1',
        authenticated: true,
        authoritySource: 'owner-session',
      },
    })).rejects.toEqual(expect.objectContaining<Partial<VoiceTurnRoutingError>>({
      code: 'invalid_principal',
    }));
  });
});
