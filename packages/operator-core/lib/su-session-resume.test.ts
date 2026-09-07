import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableSuSessionRecord } from './su-session-persistence';

const m = vi.hoisted(() => ({
  row: vi.fn(), spec: vi.fn(), acquire: vi.fn(), finalize: vi.fn(), release: vi.fn(), pid: vi.fn(), ended: vi.fn(),
  live: vi.fn(), witness: vi.fn(), transcript: vi.fn(), ompPath: vi.fn(), account: vi.fn(),
  codexRoute: vi.fn(), ompRoute: vi.fn(), envelope: vi.fn(), archive: vi.fn(),
}));
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), existsSync: () => true }));
vi.mock('../../../apps/operator/scripts/psu-launcher.mjs', () => ({
  buildResumeEnv: (row: any, opts: any) => ({ PAPERCUSP_SID: row.coordOwnerId,
    PAPERCUSP_ADV_SESSION_ID: String(row.id), ...opts.accountEnv.env }),
  codexThreadWriterHolder: () => ({ held: false, reason: 'no-lock-file' }),
  sessionProcessHolder: () => ({ held: false, reason: 'clean-scan' }),
  normalizeArgvProbeResumeLocalLivenessEvidence: m.witness,
  normalizeCodexResumeLocalLivenessEvidence: m.witness,
  ensureResumeTranscriptPresent: m.transcript,
  tryRematerializeFromArchive: m.archive,
  ensureCodexHomeViaOperator: vi.fn(), ensureInteractiveConfigViaOperator: vi.fn(),
  isClaudeConfigDirLaunchReady: () => true, isCodexHomeLaunchReady: () => true,
  rehealResumeCredentials: vi.fn(), rehealResumeCodexAuth: vi.fn(),
  applyCodexGatewayRoute: m.codexRoute, applyOmpResumeAccountRoute: m.ompRoute,
  ompTrackedResumeEnv: () => ({ PI_CODING_AGENT_DIR: '/saved/omp', PI_CONFIG_DIR: '.saved/omp' }),
}));
vi.mock('./adv-sessions', () => ({ getAdvSession: m.row, readSuLaunchSpecByOwner: m.spec,
  acquireAdvSessionResume: m.acquire, finalizeAdvSessionResume: m.finalize, releaseAdvSessionResume: m.release,
  setAdvSessionPid: m.pid, markAdvSessionEnded: m.ended }));
vi.mock('./su-persona-render', () => ({ parseSuLaunchSpecRecord: (value: unknown) => value }));
vi.mock('./console-launcher', () => ({ buildConsoleEnvelope: m.envelope }));
vi.mock('./interactive-safety-floor', () => ({ checkInteractiveSafetyFloor: async () => ({ ok: true }) }));
vi.mock('./events/await/psu-pty-discovery', () => ({ findLiveHost: m.live }));
vi.mock('./mcp-base-url', () => ({ resolveSpawnHostOperatorBaseUrl: () => 'http://localhost:3170' }));
vi.mock('./session-transcript-resolvers', () => ({ findOmpSessionPath: m.ompPath }));
vi.mock('./endpoint-route/routes/agent-mcp/bootstrap-su', () => ({ resolveAccountPin: m.account }));
import { prepareStructuredSuResume } from './su-session-resume';

function fixture(backend: 'claude' | 'codex' | 'omp'): DurableSuSessionRecord {
  m.row.mockResolvedValue({ id: 42, workspaceId: 'workspace', harnessSlug: 'project', planSlug: 'saved-plan',
    agent: backend, coordOwnerId: 'saved-owner', cwd: '/project', pid: null, sessionId: 'saved-native' });
  m.spec.mockResolvedValue({ agent: backend, workspaceId: 'workspace', harnessSlug: 'project',
    profile: 'engineer', model: 'saved-model:high', planSlug: 'saved-plan',
    specificationRevision: 'spec-1', stateRevision: 'state-2' });
  return { advSessionId: 42, workspaceId: 'workspace', agentChatId: 'saved-chat', backend,
    nativeSessionId: 'saved-native', ownerId: 'saved-owner', harnessSlug: 'project',
    runtimeGeneration: 3, pid: null, endedAt: 'yesterday', lifecycle: 'ended',
    descriptor: { identity: { agentChatId: 'saved-chat', advSessionId: 42, workspaceId: 'workspace',
      harnessSlug: 'project', backend, nativeSessionId: 'saved-native', ownerId: 'saved-owner' },
    lifecycle: 'ended', role: 'su', runtimeGeneration: 3, model: 'saved-model', accountRoute: 'named-account',
    carry: 'cold', modes: ['auto', 'ideate'], capabilities: {} as never,
    backendExtension: backend === 'claude' ? { backend, configDir: '/saved/claude', configDirSource: 'observed' }
      : backend === 'codex' ? { backend, codexHome: '/saved/codex' } : { backend, agentHome: '/saved/omp' } } } as DurableSuSessionRecord;
}

beforeEach(() => {
  vi.resetAllMocks();
  m.live.mockReturnValue(null);
  m.witness.mockReturnValue({ version: 1, kind: 'no-live-claude-process' });
  m.acquire.mockResolvedValue({ acquired: true, status: 'acquired' });
  m.finalize.mockResolvedValue(true);
  m.transcript.mockResolvedValue(true);
  m.ompPath.mockResolvedValue('/saved/omp/sessions/thread.jsonl');
  m.account.mockResolvedValue({ env: { RESTORED_ROUTE: 'named-account' }, accountId: 'named-account', provider: 'anthropic' });
  m.envelope.mockResolvedValue({ cwd: '/project', env: { PAPERCUSP_WORKSPACE: 'workspace' } });
  m.ompRoute.mockReturnValue('saved-model:high');
});

describe('structured exact resume preparation', () => {
  it.each(['claude', 'codex', 'omp'] as const)('preserves %s identity, scope and settings and finalizes only after a child exists', async (backend) => {
    const saved = fixture(backend);
    const resume = await prepareStructuredSuResume(saved);
    expect(resume.binding).toMatchObject({ operation: 'attached', advSessionId: 42, ownerId: 'saved-owner',
      workspaceId: 'workspace', harnessSlug: 'project', planSlug: 'saved-plan', backend });
    expect(resume.options).toEqual({ agentChatId: 'saved-chat', model: 'saved-model:high',
      accountRoute: 'named-account', carry: 'cold', modes: ['auto', 'ideate'], runtimeGeneration: 4 });
    expect(resume.boot.envelopeEnv).toMatchObject({ PAPERCUSP_SID: 'saved-owner', PAPERCUSP_ADV_SESSION_ID: '42',
      PAPERCUSP_WORKSPACE: 'workspace', RESTORED_ROUTE: 'named-account' });
    expect(m.finalize).not.toHaveBeenCalled();
    await expect(resume.beforeReady(null)).rejects.toThrow('no native process');
    await resume.beforeReady(12345);
    expect(m.pid).toHaveBeenCalledWith(42, 12345, `pui-structured-${backend}`);
    expect(m.finalize).toHaveBeenCalledWith(42, m.acquire.mock.calls[0][1]);
    await resume.release();
    expect(m.release).not.toHaveBeenCalled();
    await resume.onExit();
    expect(m.ended).toHaveBeenCalledWith(42, null, 'cleanup', { throwOnError: true });
  });

  it('refuses scope mismatch and a competing host before reserving or touching credentials', async () => {
    const saved = fixture('codex');
    saved.descriptor!.identity.workspaceId = 'another-workspace';
    await expect(prepareStructuredSuResume(saved)).rejects.toThrow('identity');
    const valid = fixture('codex');
    m.live.mockReturnValue({ pid: 123 });
    await expect(prepareStructuredSuResume(valid)).rejects.toThrow('live host');
    expect(m.acquire).not.toHaveBeenCalled();
    expect(m.account).not.toHaveBeenCalled();
  });

  it('refuses an unknown liveness witness or a competing lease', async () => {
    const saved = fixture('codex');
    m.witness.mockReturnValue(null);
    await expect(prepareStructuredSuResume(saved)).rejects.toThrow('exclusive ownership');
    expect(m.acquire).not.toHaveBeenCalled();
    m.witness.mockReturnValue({ version: 1, kind: 'no-live-codex-writer' });
    m.acquire.mockResolvedValue({ acquired: false, status: 'reserved' });
    await expect(prepareStructuredSuResume(saved)).rejects.toThrow('reserved');
    expect(m.account).not.toHaveBeenCalled();
  });

  it('releases the reservation when the transcript or selected account cannot be restored', async () => {
    const saved = fixture('claude');
    m.transcript.mockResolvedValue(false);
    await expect(prepareStructuredSuResume(saved)).rejects.toThrow('transcript');
    expect(m.release).toHaveBeenCalledWith(42, m.acquire.mock.calls[0][1]);
    m.transcript.mockResolvedValue(true);
    m.account.mockResolvedValue({ error: 'selected account unavailable' });
    await expect(prepareStructuredSuResume(saved)).rejects.toThrow('selected account');
    expect(m.release).toHaveBeenCalledTimes(2);
    expect(m.finalize).not.toHaveBeenCalled();
    expect(m.ended).not.toHaveBeenCalled();
  });

  it('rejects a lost lease before announcing readiness', async () => {
    const resume = await prepareStructuredSuResume(fixture('omp'));
    m.finalize.mockResolvedValue(false);
    await expect(resume.beforeReady(123)).rejects.toThrow('reservation was lost');
    await resume.onExit();
    expect(m.release).toHaveBeenCalled();
    expect(m.ended).not.toHaveBeenCalled();
  });

  it('restores archived OMP files through the selected operator before exact resume', async () => {
    const saved = fixture('omp');
    m.ompPath.mockResolvedValueOnce(null);
    const resume = await prepareStructuredSuResume(saved);
    expect(m.archive).toHaveBeenCalledWith('saved-native', 'omp', { operatorUrl: 'http://localhost:3170' });
    expect(resume.nativeSession).toMatchObject({ backend: 'omp', ompThreadId: 'saved-native', agentHome: '/saved/omp' });
    await resume.release();
  });
});
