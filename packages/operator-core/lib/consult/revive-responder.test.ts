/**
 * revive-responder.test.ts — unit tests for the WI-39852 revival spawn half
 * (plan consult-revival-and-honest-min-2026-08-18 P-001).
 *
 * Pure deps-injected unit tests: every seam (resolve / build / envelope /
 * spawn / verify) is a recording fake, so no PG, no pty host, no spawn. The
 * contract under test is the module doc's: resolve → refuse-if-live →
 * headless resume with the brief as PAPERCUSP_KICKOFF_PROMPT → three-state
 * verified — and the seam NEVER throws.
 */
import { describe, expect, it } from 'vitest';
import {
  makeConsultReviver,
  reviveConsultResponder,
  REVIVE_VERIFY_TIMEOUT_MS,
  type ConsultReviveContext,
  type ConsultReviveDeps,
} from './revive-responder';

const CTX: ConsultReviveContext = {
  workspaceId: 'ws-revive',
  harnessSlug: 'papercusp',
  launchedBy: 'su-requester',
};

const OPTS = { ownerId: 'su-dead-expert', conversationId: 'conv-r-1', brief: '🧭 You were REVIVED — QUESTION: why?' };

function makeFakes(over: Partial<Record<keyof ConsultReviveDeps, unknown>> = {}) {
  const calls = {
    resolve: [] as unknown[],
    build: [] as unknown[],
    inject: [] as unknown[],
    envelope: [] as unknown[],
    spawn: [] as Array<{
      envelope: { env: Record<string, string>; greetingCmd: string; cwd: string };
      logDir?: string | null;
      launchedBy?: string;
      kickoffProof?: boolean;
    }>,
    verify: [] as Array<{ ownerId: string; timeoutMs?: number }>,
  };
  const deps = {
    resolveResumeTarget: async (ref: unknown) => {
      calls.resolve.push(ref);
      return {
        ok: true,
        sessionId: 'sess-1',
        ownerId: 'su-dead-expert',
        agent: 'claude',
        ompThreadId: null,
        cwd: '/recorded/cwd',
        endedAt: '2026-08-18T00:00:00Z',
        endedBy: 'self',
        live: false,
        advSessionId: 7,
      };
    },
    buildAgentLaunchCommand: (o: unknown) => {
      calls.build.push(o);
      return 'psu --no-picker --account=default --resume=sess-1 --headless';
    },
    checkResumeTranscript: async () => ({ available: true, detail: 'fixture transcript' }),
    injectLaunchedByArg: (command: string, launcherOwnerId: string | null) => {
      calls.inject.push({ command, launcherOwnerId });
      return { command: `${command} --launched-by=${launcherOwnerId}`, injected: true };
    },
    buildConsoleEnvelope: async (o: unknown) => {
      calls.envelope.push(o);
      return { cwd: '/base/cwd', env: { BASE: '1' }, greetingCmd: '' };
    },
    spawnHeadless: async (o: (typeof calls.spawn)[number]) => {
      calls.spawn.push(o);
      return {
        status: 'ok',
        pid: 42,
        terminal: 'headless',
        logPath: '/logs/x.log',
        child: null,
        display: null,
        kickoffProof: { persisted: true, nativeRef: '/native/revive.jsonl', reason: null },
      };
    },
    fetchContextPressure: async () => new Map(),
    verifyResumeStarted: async (ownerId: string, o: { timeoutMs?: number } = {}) => {
      calls.verify.push({ ownerId, ...o });
      return { started: true, waitedMs: 1200 };
    },
    ...over,
  } as unknown as ConsultReviveDeps;
  return { deps, calls };
}

describe('reviveConsultResponder', () => {
  it('happy path: headless resume with the brief as the kickoff env, recorded cwd, launched-by provenance, verified:true', async () => {
    const { deps, calls } = makeFakes();
    const r = await reviveConsultResponder(OPTS, CTX, deps);
    expect(r).toMatchObject({ spawned: true, verified: true });
    expect(r.detail).toContain('su-dead-expert');
    // resume command: mode resume + headless, launched-by injected.
    expect(calls.build[0]).toMatchObject({ mode: 'resume', sessionId: 'sess-1', headless: true });
    expect(calls.inject[0]).toMatchObject({ launcherOwnerId: 'su-requester' });
    // The brief rides the ENV (never the command line), on top of the base env.
    const spawn = calls.spawn[0];
    expect(spawn.envelope.env.PAPERCUSP_KICKOFF_PROMPT).toBe(OPTS.brief);
    expect(spawn.envelope.env.BASE).toBe('1');
    expect(spawn.envelope.greetingCmd).toContain('--resume=sess-1');
    expect(spawn.envelope.greetingCmd).toContain('--launched-by=su-requester');
    // Resume lands in the session's own recorded cwd, not the envelope base.
    expect(spawn.envelope.cwd).toBe('/recorded/cwd');
    expect(spawn.logDir).toContain('fleet-logs');
    expect(spawn.launchedBy).toBe('su-requester');
    expect(spawn.kickoffProof).toBe(true);
    // Verify polls the ORIGINAL identity within the revive window.
    expect(calls.verify[0]).toMatchObject({ ownerId: 'su-dead-expert', timeoutMs: REVIVE_VERIFY_TIMEOUT_MS });
  });

  it('forwards the recorded Codex model and source when reviving a session', async () => {
    const { deps, calls } = makeFakes({
      resolveResumeTarget: async () => ({
        ok: true,
        sessionId: null,
        resumeId: '22662',
        ownerId: 'su-dead-expert',
        agent: 'codex',
        cwd: '/recorded/cwd',
        model: 'gpt-5.6-sol:xhigh',
        modelSource: 'inherited',
        endedAt: '2026-08-18T00:00:00Z',
        endedBy: 'self',
        live: false,
        advSessionId: 22662,
        binding: null,
      }),
    });

    await reviveConsultResponder(OPTS, CTX, deps);

    expect(calls.build[0]).toMatchObject({
      mode: 'resume',
      resumeId: '22662',
      agent: 'codex',
      model: 'gpt-5.6-sol:xhigh',
      modelSource: 'inherited',
    });
  });

  it('supplies the canonical configured Codex default when a legacy target has no recorded model', async () => {
    const { deps, calls } = makeFakes({
      resolveResumeTarget: async () => ({
        ok: true,
        sessionId: null,
        resumeId: '22663',
        ownerId: 'su-dead-expert',
        agent: 'codex',
        cwd: '/recorded/cwd',
        model: null,
        modelSource: null,
        endedAt: '2026-08-18T00:00:00Z',
        endedBy: 'self',
        live: false,
        advSessionId: 22663,
        binding: null,
      }),
    });

    await reviveConsultResponder(OPTS, CTX, deps);

    expect(calls.build[0]).toMatchObject({
      mode: 'resume',
      resumeId: '22663',
      agent: 'codex',
      model: 'gpt-5.6-sol:xhigh',
      modelSource: 'configured-default',
    });
  });

  it('refuse-if-live (WI-3882): a live-reading target is never resumed in place', async () => {
    const { deps, calls } = makeFakes({
      resolveResumeTarget: async () => ({
        ok: true,
        sessionId: 'sess-1',
        ownerId: 'su-dead-expert',
        agent: 'claude',
        cwd: null,
        endedAt: null,
        endedBy: null,
        live: true,
        advSessionId: 7,
      }),
    });
    const r = await reviveConsultResponder(OPTS, CTX, deps);
    expect(r).toMatchObject({ spawned: false, reason: 'live-collision' });
    expect(r.detail).toContain('WI-3882');
    expect(calls.spawn).toHaveLength(0);
  });

  it('refuses a context-exhausted responder before kickoff delivery can be mistaken for pickup', async () => {
    const { deps, calls } = makeFakes({
      fetchContextPressure: async () => new Map([['su-dead-expert', 'critical']]),
    });
    const r = await reviveConsultResponder(OPTS, CTX, deps);
    expect(r).toMatchObject({ spawned: false, verified: null });
    expect(r.detail).toContain('current context is CRITICAL');
    expect(r.detail).toContain('refused before spawn');
    expect(calls.spawn).toHaveLength(0);
    expect(calls.verify).toHaveLength(0);
  });

  it('refuses an ended target with no transcript or archive before spawning', async () => {
    const { deps, calls } = makeFakes({
      checkResumeTranscript: async () => ({
        available: false,
        detail: 'native transcript unavailable (not_archived)',
      }),
    });
    const r = await reviveConsultResponder(OPTS, CTX, deps);
    expect(r).toMatchObject({ spawned: false, verified: null });
    expect(r.detail).toContain('native transcript unavailable');
    expect(r.detail).toContain('refused before spawn');
    expect(calls.build).toHaveLength(0);
    expect(calls.spawn).toHaveLength(0);
    expect(calls.verify).toHaveLength(0);
  });

  it('fails closed when context-pressure preflight cannot run', async () => {
    const { deps, calls } = makeFakes({
      fetchContextPressure: async () => {
        throw new Error('presence store unavailable');
      },
    });
    const r = await reviveConsultResponder(OPTS, CTX, deps);
    expect(r).toMatchObject({ spawned: false, verified: null });
    expect(r.detail).toContain('presence store unavailable');
    expect(calls.spawn).toHaveLength(0);
  });

  it('unresolvable target: spawned:false with the resolver detail', async () => {
    const { deps } = makeFakes({
      resolveResumeTarget: async () => ({ ok: false, error: 'not_found', detail: 'no adv_sessions row for agent x' }),
    });
    const r = await reviveConsultResponder(OPTS, CTX, deps);
    expect(r.spawned).toBe(false);
    expect(r.detail).toContain('no adv_sessions row');
  });

  it('spawn failure: spawned:false carrying the spawn error', async () => {
    const { deps } = makeFakes({
      spawnHeadless: async () => ({ status: 'error', error: 'no systemd-run', code: 3 }),
    });
    const r = await reviveConsultResponder(OPTS, CTX, deps);
    expect(r.spawned).toBe(false);
    expect(r.detail).toContain('no systemd-run');
  });

  it('verify window elapses: verified is null (still booting — NOT a failure), spawned stands', async () => {
    const { deps } = makeFakes({
      verifyResumeStarted: async () => ({ started: false, waitedMs: REVIVE_VERIFY_TIMEOUT_MS }),
    });
    const r = await reviveConsultResponder(OPTS, CTX, deps);
    expect(r).toMatchObject({ spawned: true, verified: null });
    expect(r.detail).toContain('NOT a failure');
  });

  it('a delayed nonzero child exit overrides the unconfirmed host window', async () => {
    const { deps } = makeFakes({
      spawnHeadless: async () => ({
        status: 'ok',
        pid: 42,
        terminal: 'headless',
        logPath: '/logs/x.log',
        child: null,
        display: null,
        kickoffProof: { persisted: true, nativeRef: '/native/revive.jsonl', reason: null },
        childExit: Promise.resolve({ code: 2, signal: null }),
      }),
      verifyResumeStarted: () => new Promise(() => {}),
    });
    const r = await reviveConsultResponder(OPTS, CTX, deps);
    expect(r).toMatchObject({ spawned: false, verified: false });
    expect(r.detail).toMatch(/status 2/);
    expect(r.detail).toContain('not successful');
  });

  it.each([
    ['missing', undefined],
    ['negative', { persisted: false, nativeRef: null, reason: 'kickoff-proof-timeout' }],
  ])('fails closed when an ok headless spawn has %s native kickoff proof', async (_label, kickoffProof) => {
    const { deps, calls } = makeFakes({
      spawnHeadless: async () => ({
        status: 'ok',
        pid: 42,
        terminal: 'headless',
        logPath: '/logs/x.log',
        child: null,
        display: null,
        ...(kickoffProof === undefined ? {} : { kickoffProof }),
      }),
    });
    const r = await reviveConsultResponder(OPTS, CTX, deps);
    expect(r).toMatchObject({ spawned: false, verified: false });
    expect(r.detail).toMatch(/kickoff-proof-(missing|timeout)/);
    expect(calls.verify).toHaveLength(0);
  });

  it('NEVER throws: a throwing seam resolves as spawned:false', async () => {
    const { deps } = makeFakes({
      buildConsoleEnvelope: async () => {
        throw new Error('unknown harness slug: nope');
      },
    });
    const r = await reviveConsultResponder(OPTS, CTX, deps);
    expect(r.spawned).toBe(false);
    expect(r.detail).toContain('unknown harness slug');
  });

  it('makeConsultReviver binds the requester context onto the GetFeedbackDeps.revive shape', async () => {
    const { deps, calls } = makeFakes();
    const revive = makeConsultReviver(CTX, deps);
    const r = await revive(OPTS);
    expect(r.spawned).toBe(true);
    expect(calls.envelope[0]).toMatchObject({ workspaceId: 'ws-revive', slug: 'papercusp' });
  });
});
