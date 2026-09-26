import { describe, expect, it, vi } from 'vitest';
import { buildAgentLaunchCommand, injectLaunchedByArg } from '../agent-launch-core';
import {
  dispatchConsultResponder,
  selectConsultEvidenceSource,
  type ConsultDispatchDeps,
  type ConsultDispatchEvidenceRef,
} from './consult-dispatch';
import type { AllowedExpertModel } from './expert-model-allowlist';

const context = { workspaceId: 'ws', harnessSlug: 'papercusp', launchedBy: 'su-requester' };
const targetFor = (sessionId: string) => ({
  ok: true as const,
  sessionId,
  resumeId: sessionId,
  ompThreadId: null,
  ownerId: 'su-expert',
  agent: 'claude',
  cwd: '/source',
  model: null,
  modelSource: null,
  endedAt: '2026-09-22T00:00:00.000Z',
  endedBy: 'self' as const,
  live: false,
  advSessionId: 17,
  binding: null,
});

function depsFor(input: { ranks: AllowedExpertModel[]; resolved?: string[] }) {
  const launched: Array<{ envelope: { env: Record<string, string>; greetingCmd: string; cwd: string } }> = [];
  const resolved: unknown[] = [];
  let minted = 0;
  const deps: Partial<ConsultDispatchDeps> = {
    resolveResumeTarget: vi.fn(async (ref: { agentId?: string | null; sessionId?: string | null }) => {
      resolved.push(ref);
      const sessionId = ref.sessionId ?? input.resolved?.[0] ?? 'latest-session';
      return targetFor(sessionId);
    }) as never,
    checkResumeTranscript: async () => ({ available: true, detail: 'source is readable' }),
    buildAgentLaunchCommand,
    injectLaunchedByArg,
    buildConsoleEnvelope: async () => ({ cwd: '/fallback', env: { BASE: '1' }, greetingCmd: '' }) as never,
    spawnHeadless: async (options: Parameters<ConsultDispatchDeps['spawnHeadless']>[0]) => {
      launched.push(options);
      return {
        status: 'ok', pid: 12, terminal: 'headless', logPath: '/logs/consult', child: null, display: null,
        kickoffProof: { persisted: true, nativeRef: '/native/answer.jsonl', reason: null },
      } as Awaited<ReturnType<ConsultDispatchDeps['spawnHeadless']>>;
    },
    verifyResumeStarted: (async (_ownerId: string) => ({ started: true, waitedMs: 1 })) as never,
    fetchContextPressure: async () => new Map(),
    probeBackendAvailable: async () => ({ available: true, detail: 'headroom' }),
    mintOwnerId: () => `su-answer-${++minted}`,
    loadRanks: async () => input.ranks,
    // Unit tier: the default recorder writes through the real org pool (WI-10003197).
    readLaunchLogReason: async () => null,
    recordDispatchAttempts: async () => {},
    // Likewise the cool-down reader (WI-10003198): no history ⇒ no cool-down.
    readSourceDispatchRecords: async () => [],
  };
  return { deps, launched, resolved };
}

describe('P-007 consult evidence span routing', () => {
  it('uses the exact highest-ranked evidence session and passes only its refs to conversion', async () => {
    const evidence: ConsultDispatchEvidenceRef[] = [
      { session_id: 'session-weaker', turn_idx: 8, sim: 0.62 },
      { session_id: 'session-best', turn_idx: 4, sim: 0.91 },
      { session_id: 'session-best', turn_idx: 6, sim: 0.83 },
    ];
    expect(selectConsultEvidenceSource(evidence)).toEqual({
      sessionId: 'session-best',
      evidence: [evidence[1], evidence[2]],
    });

    const fakes = depsFor({ ranks: [{ rank: 1, agent: 'codex', model: 'sol' }] });
    const result = await dispatchConsultResponder({
      sourceOwnerId: 'su-expert',
      conversationId: 'conv-evidence',
      evidence,
      brief: 'answer from the selected evidence',
    }, context, fakes.deps);

    expect(result).toMatchObject({ dispatched: true, operation: 'convert', answeringOwnerId: 'su-expert' });
    expect(fakes.resolved).toEqual([{ sessionId: 'session-best' }]);
    const env = fakes.launched[0]!.envelope.env;
    expect(JSON.parse(env.PAPERCUSP_CONSULT_EVIDENCE_SPAN!)).toEqual({
      sessionId: 'session-best',
      turnIndices: [4, 6],
      contextTurns: 2,
    });
    expect(env.PAPERCUSP_KICKOFF_PROMPT).toContain('session-best#4; session-best#6');
    expect(env.PAPERCUSP_KICKOFF_PROMPT).not.toContain('session-weaker#8');
  });

  it('does not fall back to a full-transcript conversion when exact evidence is absent', async () => {
    const fakes = depsFor({ ranks: [{ rank: 1, agent: 'codex', model: 'sol' }] });
    const result = await dispatchConsultResponder({
      sourceOwnerId: 'su-expert', conversationId: 'conv-no-evidence', brief: 'answer',
    }, context, fakes.deps);
    expect(result.dispatched).toBe(false);
    expect(result.attempts).toMatchObject([{ operation: 'convert', outcome: 'skipped', reason: 'evidence-span-unavailable' }]);
    expect(fakes.launched).toHaveLength(0);
  });
});
