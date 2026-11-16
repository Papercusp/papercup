import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProjectedTool, UnifiedToolContext, KernelEnforcementRequest } from '@papercusp/tooldef';
import type { LoadedPlugin, PluginDiscoveryInventory } from '@papercusp/plugin-loader';
import type { ToolDefinition } from '@papercusp/plugin-sdk';
import { compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { defaultCensusRoot, SU_RENDER_PARITY_BASELINE } from './identity-surface-census';
import { IDOP_P001_BASELINE_REL, IDOP_P001_PROMPT_REL, inspectIdopP001Coverage,
  runIdopP001PermissionComparison, loadIdopP001RolePermissionReader, loadIdopP001DispatchPermissionReader,
  readIdopP001ExpectedPermissionDifferences, IDOP_P001_DIFFERENCES_REL,
  readIdopP001CurrentBuiltinPopulation,
  readIdopP001CurrentLibraryPopulation, readIdopP001AppliedStackPopulation,
  readIdopP001InstalledPluginToolPopulation,
  joinIdopP001ComparisonPopulation,
  captureIdopP001HostPermissionPorts,
  replayIdopP001HostPermissionSnapshot,
  captureIdopP001KernelPermissionPorts,
  replayIdopP001KernelPermissionSnapshot,
  inspectIdopP001AppliedStackArchive,
  IDOP_P001_ROLE_POLICY_SOURCES,
  type IdopPermissionDifference, type IdopHostPermissionPorts, type IdopInnerKernelPorts } from './idop-p001-baseline';

type Baseline = {
  schemaVersion: number;
  base: { commit: string; promptPath: string; promptGitBlob: string; promptSha256: string; promptBytes: number };
  population: { roles: Array<{ id: string }>; roleCount: number; builtInIdentities: Array<{ id: string }>; builtInIdentityCount: number };
  toolCatalog: { sourceKind: string; count: number; digest: string; tools: Array<{ name: string; schema: unknown; schemaSha256: string }> };
  observations: Array<{ identity: string; ownerId: string; observedAt: string; status: 'observed' | 'tool-refused' | 'launch-refused'; toolInvocationId?: number; activationEventId?: number; refusal?: string }>;
  overrideChannels: string[];
  vault: { baseline: Record<string, string>; evidence: string[]; supersededBy: string };
  answers: Record<string, string>;
  knownDefect: string;
};

const root = defaultCensusRoot();
const baseline = JSON.parse(readFileSync(join(root, IDOP_P001_BASELINE_REL), 'utf8')) as Baseline;
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const hostFlagAttestation = () => ({ key: 'papercusp-capability-envelope' as const,
  resolvedValue: true, compiledDefault: true, source: 'override-store' as const,
  backendConfigured: false, observedAtMs: 1,
  overrideRead: { kind: 'store-load' as const, storeConfigured: true, cacheKey: 'snapshot-workspace',
    cacheGeneration: 1, cacheLoadedAtMs: 1, cacheAgeMs: 0, ttlMs: 0, ttlRemainingMs: 0, loadError: null } });

describe('IDOP D-043 immutable host authority read inputs', () => {
  const ctx = (): UnifiedToolContext => ({ log: vi.fn(), signal: new AbortController().signal,
    progress: vi.fn(), emit: vi.fn(), workspaceId: 'snapshot-workspace', uiClientId: 'su-original',
    role: 'worker', isSuperuser: true, runId: 'original-run', spawnId: 'original-spawn', parentSpawnId: null });
  const options = () => ({ workspaceId: 'snapshot-workspace', contexts: [ctx()],
    flags: [{ key: 'papercusp-capability-envelope' as const, distinctId: 'system' }] });
  const readers = () => ({
    resolveConfinement: vi.fn(async () => ({ denyTools: ['secrets:*'], imposedBy: 'original-launcher', reason: 'assignment' })),
    ensureConfinementReady: vi.fn(async () => {}),
    audit: { resolveIdentity: vi.fn(() => ({ ownerId: 'su-original', workspaceId: 'snapshot-workspace' })),
      readModes: vi.fn(async () => [{ mode: 'audit' }]) },
    roleOverrides: vi.fn(() => ({ worker: { denyCapabilities: ['secrets:*'] } })),
    protectedAdditions: vi.fn(() => ['original:*']),
    readFlagAttestation: vi.fn(async () => hostFlagAttestation()),
  });

  it('captures once, replays original contexts and attested flags, and never re-reads live authority', async () => {
    const source = readers();
    const input = options();
    const result = await captureIdopP001HostPermissionPorts(input, source);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(source.resolveConfinement).toHaveBeenCalledWith(input.contexts[0]);
    expect(source.readFlagAttestation).toHaveBeenCalledWith('papercusp-capability-envelope', 'system');
    for (let arm = 0; arm < 2; arm++) {
      expect(await result.ports.resolveConfinement(ctx())).toMatchObject({ imposedBy: 'original-launcher' });
      expect(result.ports.audit.resolveIdentity(ctx())).toEqual({ ownerId: 'su-original', workspaceId: 'snapshot-workspace' });
      expect(await result.ports.audit.readModes('snapshot-workspace', 'su-original')).toEqual([{ mode: 'audit' }]);
      expect(await result.ports.getFlag('papercusp-capability-envelope', 'system')).toBe(true);
    }
    expect(source.ensureConfinementReady).toHaveBeenCalledTimes(1);
    expect(source.resolveConfinement).toHaveBeenCalledTimes(1);
    expect(source.audit.readModes).toHaveBeenCalledTimes(1);
    expect(source.readFlagAttestation).toHaveBeenCalledTimes(1);
    expect(result.snapshot.flags[0].attestation.source).toBe('override-store');
  });

  it('isolates caller evidence and each policy arm from mutation', async () => {
    const input = options();
    const result = await captureIdopP001HostPermissionPorts(input, readers());
    input.workspaceId = 'changed-after-capture';
    result.snapshot.contexts[0].identity.ownerId = 'other';
    result.snapshot.flags[0].attestation.resolvedValue = false;
    result.snapshot.protectedAdditions = ['new:*'];
    const first = await result.ports.resolveConfinement(ctx());
    (first!.denyTools as string[]).push('new:*');
    (result.ports.roleOverrides().worker.denyCapabilities as string[]).push('new:*');
    expect(await result.ports.resolveConfinement(ctx())).toMatchObject({ denyTools: ['secrets:*'] });
    expect(result.ports.audit.resolveIdentity(ctx()).ownerId).toBe('su-original');
    expect(result.ports.roleOverrides().worker.denyCapabilities).toEqual(['secrets:*']);
    expect(result.ports.protectedAdditions()).toEqual(['original:*']);
    expect(await result.ports.getFlag('papercusp-capability-envelope', 'system')).toBe(true);
  });

  it('reloads persisted envelope authority without live readers and isolates both source arms', async () => {
    const source = readers();
    const saved = await captureIdopP001HostPermissionPorts(options(), source);
    const bytes = JSON.stringify(saved.snapshot);
    source.audit.readModes.mockRejectedValue(new Error('original host is no longer available'));
    const old = replayIdopP001HostPermissionSnapshot(JSON.parse(bytes), saved.sha256);
    const candidate = replayIdopP001HostPermissionSnapshot(JSON.parse(bytes), saved.sha256);
    old.snapshot.contexts[0].identity.ownerId = 'forged';
    old.snapshot.flags[0].attestation.resolvedValue = false;
    const overrides = old.ports.roleOverrides();
    (overrides.worker.denyCapabilities as string[]).push('new:*');
    for (const { ports } of [old, candidate]) {
      expect(ports.audit.resolveIdentity(ctx()).ownerId).toBe('su-original');
      expect(await ports.audit.readModes('snapshot-workspace', 'su-original')).toEqual([{ mode: 'audit' }]);
      expect(await ports.resolveConfinement(ctx())).toMatchObject({ denyTools: ['secrets:*'] });
      expect(ports.roleOverrides().worker.denyCapabilities).toEqual(['secrets:*']);
      expect(await ports.getFlag('papercusp-capability-envelope', 'system')).toBe(true);
    }
    expect(source.audit.readModes).toHaveBeenCalledOnce();
    const changed = JSON.parse(bytes);
    changed.flags[0].attestation.resolvedValue = false;
    expect(() => replayIdopP001HostPermissionSnapshot(changed, saved.sha256)).toThrow(/hash mismatch/);
  });

  it.each(['version', 'scope', 'foreign-context', 'context-tag', 'duplicate-context', 'missing-modes',
    'foreign-modes', 'duplicate-modes', 'duplicate-mode', 'duplicate-flag', 'degraded-flag', 'extra-field'])(
    'rejects structurally invalid persisted %s even with a matching hash', async kind => {
      const { snapshot } = await captureIdopP001HostPermissionPorts(options(), readers());
      const edited = JSON.parse(JSON.stringify(snapshot));
      if (kind === 'version') edited.schemaVersion = 2;
      if (kind === 'scope') edited.scope = 'other';
      if (kind === 'foreign-context') edited.workspaceId = 'foreign';
      if (kind === 'context-tag') edited.contexts[0].key = '["object",[["workspaceId","snapshot-workspace"],["workspaceId","snapshot-workspace"]]]';
      if (kind === 'duplicate-context') edited.contexts.push(edited.contexts[0]);
      if (kind === 'missing-modes') edited.modes = [];
      if (kind === 'foreign-modes') edited.modes[0].key = '["snapshot-workspace","foreign"]';
      if (kind === 'duplicate-modes') edited.modes.push(edited.modes[0]);
      if (kind === 'duplicate-mode') edited.modes[0].rows.push(edited.modes[0].rows[0]);
      if (kind === 'duplicate-flag') edited.flags.push(edited.flags[0]);
      if (kind === 'degraded-flag') edited.flags[0].attestation.overrideRead.loadError = 'unavailable';
      if (kind === 'extra-field') edited.uncaptured = true;
      const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` :
        value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}` : JSON.stringify(value);
      expect(() => replayIdopP001HostPermissionSnapshot(edited, sha256(canonical(edited)))).toThrow(/malformed/);
    });

  it('refuses uncaptured privilege, principal, original run, workspace, mode identity and flag lookups', async () => {
    const { ports } = await captureIdopP001HostPermissionPorts(options(), readers());
    for (const change of [{ isSuperuser: false }, { runId: 'other-run' }, { uiClientId: 'su-other' },
      { role: 'judge' }, { workspaceId: 'foreign' }, { principal: { type: 'system', id: 'other' } }]) {
      expect(() => ports.resolveConfinement({ ...ctx(), ...change } as UnifiedToolContext)).toThrow(/context/);
    }
    await expect(ports.audit.readModes('snapshot-workspace', 'su-other')).rejects.toThrow(/not captured/);
    await expect(ports.getFlag('papercusp-capability-envelope', 'other')).rejects.toThrow(/not captured/);
  });

  it('preserves the dispatcher transaction guard without reading it and rejects a supplied transaction', async () => {
    const original = ctx();
    const readTransaction = vi.fn(() => { throw new Error('transaction contract guard'); });
    Object.defineProperty(original, 'tx', { get: readTransaction });
    const result = await captureIdopP001HostPermissionPorts({ ...options(), contexts: [original] }, readers());
    expect(await result.ports.resolveConfinement(original)).toMatchObject({ imposedBy: 'original-launcher' });
    expect(readTransaction).not.toHaveBeenCalled();
    await expect(captureIdopP001HostPermissionPorts({ ...options(), contexts: [{ ...ctx(), tx: {} }] }, readers()))
      .rejects.toThrow(/transaction/);
  });

  it('retains original principal Set capabilities in host context keys', async () => {
    const original = { ...ctx(), principal: { kind: 'service' as const, slug: 'app:original', trust: 'verified' as const,
      authMethod: 'bearer-token' as const, workspaceId: 'snapshot-workspace', capabilities: new Set(['mail:send']) } };
    const captured = await captureIdopP001HostPermissionPorts({ ...options(), contexts: [original] }, readers());
    expect(await captured.ports.resolveConfinement({ ...original, principal: { ...original.principal,
      capabilities: new Set(['mail:send']) } })).toMatchObject({ imposedBy: 'original-launcher' });
    expect(() => captured.ports.resolveConfinement({ ...original, principal: { ...original.principal,
      capabilities: new Set(['forged:*']) } })).toThrow(/not captured/);
  });

  it.each(['unconfigured', 'store-error', 'stale-cache-fallback'])('rejects %s flag authority', async kind => {
    const source = readers();
    const attestation = await source.readFlagAttestation();
    Object.assign(attestation.overrideRead, { kind, storeConfigured: kind !== 'unconfigured' });
    source.readFlagAttestation.mockResolvedValue(attestation);
    await expect(captureIdopP001HostPermissionPorts(options(), source)).rejects.toThrow(/flag authority/);
  });

  it('rejects mismatched flag attestations, missing identity and duplicate context inputs', async () => {
    const source = readers();
    const attestation = await source.readFlagAttestation();
    Object.assign(attestation, { key: 'other' });
    source.readFlagAttestation.mockResolvedValue(attestation);
    await expect(captureIdopP001HostPermissionPorts(options(), source)).rejects.toThrow(/flag authority/);
    const missing = readers();
    missing.audit.resolveIdentity.mockReturnValue({ ownerId: '', workspaceId: 'snapshot-workspace' });
    await expect(captureIdopP001HostPermissionPorts(options(), missing)).rejects.toThrow(/identity/);
    await expect(captureIdopP001HostPermissionPorts({ ...options(), contexts: [ctx(), ctx()] }, readers()))
      .rejects.toThrow(/duplicate/);
  });

  it('propagates read failures and refuses readers that mutate original caller authority', async () => {
    const source = readers();
    source.audit.readModes.mockRejectedValue(new Error('authority unavailable'));
    await expect(captureIdopP001HostPermissionPorts(options(), source)).rejects.toThrow('authority unavailable');
    const mutating = readers();
    mutating.audit.resolveIdentity.mockImplementation((...args: unknown[]) => {
      (args[0] as UnifiedToolContext).isSuperuser = false;
      return { ownerId: 'su-original', workspaceId: 'snapshot-workspace' };
    });
    await expect(captureIdopP001HostPermissionPorts(options(), mutating)).rejects.toThrow(/mutated/);
  });
});

describe('IDOP D-043 immutable original kernel authority snapshot', () => {
  const fixture = () => {
    const request: KernelEnforcementRequest = { phase: 'enforce', boundary: 'dispatch',
      toolName: 'mail:send', capabilities: ['mail:send'], args: { target: 'original' },
      ctx: { workspaceId: 'kernel-workspace', uiClientId: 'original-owner', role: 'worker', isSuperuser: true,
        runId: 'original-run', spawnId: 'original-spawn', log: vi.fn(), signal: new AbortController().signal,
        progress: vi.fn(), emit: vi.fn(), principal: { kind: 'service', slug: 'app:original-app', trust: 'verified',
          authMethod: 'bearer-token', workspaceId: 'kernel-workspace', capabilities: new Set(['mail:send']) } } };
    const binding = { planSlug: 'original-plan', harnessSlug: 'papercusp' };
    const policyInput = { workspaceId: 'kernel-workspace', harnessSlug: 'papercusp', role: 'worker', classRefs: [] };
    const claim = { workspaceId: 'kernel-workspace', harnessSlug: 'papercusp', workItemId: 'WI-original',
      ownerId: 'original-owner', advSessionId: 'original-session', acceptedOperation: { id: 'original-operation' } };
    const options: Parameters<typeof captureIdopP001KernelPermissionPorts>[0] = {
      workspaceId: 'kernel-workspace', requests: [{ request }], policyInputs: [policyInput], operationClaims: [claim],
      toolNames: ['mail:send', 'absent:tool'], apps: [{ appId: 'original-app', tokenIds: ['original-token'] }],
      convergence: [{ args: ['original-owner', 'kernel-workspace', 7,
        { specificationRevision: 'original-spec', stateRevision: 'original-state' }],
        result: false, evidenceRefs: ['original-convergence-receipt'] }],
    };
    const readers: Parameters<typeof captureIdopP001KernelPermissionPorts>[1] = {
      inner: { runtime: { pid: 12345, processId: 'original-process' },
        readState: vi.fn(async () => ({ revoked: true })),
        resolveIdentity: vi.fn(() => ({ ownerId: 'original-owner', workspaceId: 'kernel-workspace' })),
        readPolicy: vi.fn(async () => ({ policyRevision: 'original-policy', potSlug: 'papercusp',
          bindings: [], ceilings: [{ denyCapabilities: ['secrets:*'] }], protectedAdditions: [],
          tools: new Map([['mail:send', ['mail:send']]]) })),
        readOperationEffectClaim: vi.fn(async () => true), resolveTool: vi.fn(() => undefined),
        plan: { readBindings: vi.fn(async () => [binding]),
          resolveGoal: vi.fn(async () => ({ goal: null, diagnostics: ['original-diagnostic'] })),
          checkPlan: vi.fn(async () => ['original-not-ready']) } },
      app: { loadRow: vi.fn(async () => null), loadAccessTokenRow: vi.fn(async () => null),
        lookupTool: vi.fn(name => name === 'absent:tool' ? undefined : { name, capabilities: ['mail:send'] }),
        loadSpendStatus: vi.fn(async () => ({ capCents: 100, spentCents: 25, windowSec: null })),
        now: vi.fn(() => new Date('2026-11-16T11:00:00Z')) },
      organization: { loadChain: vi.fn(async () => ({ status: 'none' as const })),
        now: vi.fn(() => new Date('2026-11-16T10:59:00Z')) },
    };
    return { request, binding, policyInput, claim, options, readers };
  };

  it('captures original reads once and replays Map, Date, principal Set and explicit absent rows in both arms', async () => {
    const f = fixture();
    const captured = await captureIdopP001KernelPermissionPorts(f.options, f.readers);
    expect(captured.sha256).toMatch(/^[a-f0-9]{64}$/);
    for (let arm = 0; arm < 2; arm++) {
      const { inner, app, organization } = captured.createPorts();
      expect(await inner.readState(f.request)).toEqual({ revoked: true });
      expect(inner.resolveIdentity(f.request.ctx).ownerId).toBe('original-owner');
      expect(inner.runtime).toEqual({ pid: 12345, processId: 'original-process' });
      expect((await inner.readPolicy(f.policyInput)).tools.get('mail:send')).toEqual(['mail:send']);
      expect(await inner.readOperationEffectClaim(f.claim)).toBe(true);
      expect(await inner.plan.readBindings('original-owner', 'kernel-workspace')).toEqual([f.binding]);
      expect(await inner.plan.resolveGoal('original-owner', 'kernel-workspace')).toEqual({ goal: null, diagnostics: ['original-diagnostic'] });
      expect(await inner.plan.checkPlan(f.binding, 'kernel-workspace')).toEqual(['original-not-ready']);
      expect(inner.resolveTool('absent:tool')).toBeUndefined();
      expect(app.lookupTool('absent:tool')).toBeUndefined();
      expect(app.lookupTool('mail:send')!.capabilities).toEqual(['mail:send']);
      expect(await app.loadRow('original-app')).toBeNull();
      expect(await app.loadAccessTokenRow('original-token', 'original-app')).toBeNull();
      expect(await app.loadSpendStatus('original-app', app.now())).toMatchObject({ spentCents: 25 });
      expect(organization!.now().toISOString()).toBe('2026-11-16T10:59:00.000Z');
      expect(await organization!.loadChain('kernel-workspace')).toEqual({ status: 'none' });
      expect(await inner.converge(...f.options.convergence[0].args)).toBe(false);
    }
    expect(f.readers.inner.readState).toHaveBeenCalledOnce();
    expect(f.readers.inner.readPolicy).toHaveBeenCalledOnce();
    expect(f.readers.app.loadSpendStatus).toHaveBeenCalledWith('original-app', new Date('2026-11-16T11:00:00Z'));
    expect(f.readers.organization!.loadChain).toHaveBeenCalledOnce();
    expect(f.readers.inner.plan.checkPlan).toHaveBeenCalledOnce();
  });

  it('isolates evidence, source objects, returned data and each bounded state cursor', async () => {
    const f = fixture();
    f.options.requests[0].stateReadCount = 2;
    vi.mocked(f.readers.inner.readState).mockResolvedValueOnce({ revoked: true }).mockResolvedValueOnce({ revoked: false });
    const captured = await captureIdopP001KernelPermissionPorts(f.options, f.readers);
    captured.snapshot.entries.length = 0;
    captured.snapshot.runtime = null;
    f.readers.inner.runtime.pid = 99999;
    f.binding.planSlug = 'changed-after-capture';
    const first = captured.createPorts(), second = captured.createPorts();
    expect(await first.inner.readState(f.request)).toEqual({ revoked: true });
    expect(await first.inner.readState(f.request)).toEqual({ revoked: false });
    await expect(first.inner.readState(f.request)).rejects.toThrow(/exhausted/);
    expect(await second.inner.readState(f.request)).toEqual({ revoked: true });
    first.app.now().setFullYear(2000);
    const policy = await first.inner.readPolicy(f.policyInput);
    (policy.tools as Map<string, string[]>).get('mail:send')!.push('forged:*');
    expect(second.app.now().getUTCFullYear()).toBe(2026);
    expect((await second.inner.readPolicy(f.policyInput)).tools.get('mail:send')).toEqual(['mail:send']);
    expect(second.inner.runtime.pid).toBe(12345);
    expect(await second.inner.plan.readBindings('original-owner', 'kernel-workspace'))
      .toEqual([{ planSlug: 'original-plan', harnessSlug: 'papercusp' }]);
  });

  it('preserves undefined, signed zero and literal tag-looking arrays without JSON collisions', async () => {
    const f = fixture();
    const state = { revoked: false, extra: { omitted: undefined, zero: -0, literal: ['date', 'not-a-date'] } };
    vi.mocked(f.readers.inner.readState).mockResolvedValue(state);
    const replay = (await captureIdopP001KernelPermissionPorts(f.options, f.readers)).createPorts();
    const result = await replay.inner.readState(f.request) as typeof state;
    expect(Object.hasOwn(result.extra, 'omitted')).toBe(true);
    expect(result.extra.omitted).toBeUndefined();
    expect(Object.is(result.extra.zero, -0)).toBe(true);
    expect(result.extra.literal).toEqual(['date', 'not-a-date']);
  });

  it('rehydrates persisted authority without original readers and isolates both replay arms', async () => {
    const f = fixture();
    f.options.requests[0].stateReadCount = 2;
    vi.mocked(f.readers.inner.readState).mockResolvedValueOnce({ revoked: true }).mockResolvedValueOnce({ revoked: false });
    const captured = await captureIdopP001KernelPermissionPorts(f.options, f.readers);
    const directory = mkdtempSync(join(tmpdir(), 'idop-kernel-snapshot-'));
    try {
      const path = join(directory, 'original.json');
      writeFileSync(path, JSON.stringify(captured.snapshot), { mode: 0o600 });
      const persisted = JSON.parse(readFileSync(path, 'utf8'));
      const replay = replayIdopP001KernelPermissionSnapshot(persisted, captured.sha256);
      persisted.entries.length = 0;
      replay.snapshot.entries.length = 0;
      captured.snapshot.entries.length = 0;
      const first = replay.createPorts(), second = replay.createPorts();
      expect(await first.inner.readState(f.request)).toEqual({ revoked: true });
      expect(await first.inner.readState(f.request)).toEqual({ revoked: false });
      await expect(first.inner.readState(f.request)).rejects.toThrow(/exhausted/);
      expect(await second.inner.readState(f.request)).toEqual({ revoked: true });
      expect((await second.inner.readPolicy(f.policyInput)).tools.get('mail:send')).toEqual(['mail:send']);
      expect(second.app.now()).toEqual(new Date('2026-11-16T11:00:00Z'));
      expect(await second.inner.converge(...f.options.convergence[0].args)).toBe(false);
      expect(f.readers.inner.readState).toHaveBeenCalledTimes(2);
      expect(f.readers.inner.readPolicy).toHaveBeenCalledOnce();
      expect(f.readers.app.now).toHaveBeenCalledOnce();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('refuses altered bytes against the independently retained capture digest', async () => {
    const f = fixture();
    const captured = await captureIdopP001KernelPermissionPorts(f.options, f.readers);
    captured.snapshot.workspaceId = 'forged';
    expect(() => replayIdopP001KernelPermissionSnapshot(captured.snapshot, captured.sha256)).toThrow(/hash mismatch/);
    expect(() => replayIdopP001KernelPermissionSnapshot({}, '')).toThrow(/hash mismatch/);
  });

  it.each(['version', 'extra-field', 'runtime', 'tag-arity', 'duplicate-entry', 'unknown-port',
    'state-omission', 'state-count', 'extra-state', 'missing-clock', 'missing-evidence', 'convergence-result',
    'organization-installation'])('rejects malformed persisted %s even with a matching digest', async kind => {
    const f = fixture();
    const snapshot = (await captureIdopP001KernelPermissionPorts(f.options, f.readers)).snapshot;
    const row = (port: string) => snapshot.entries.find(entry => JSON.parse(entry.key)[0] === port)!;
    if (kind === 'version') Object.assign(snapshot, { schemaVersion: 2 });
    if (kind === 'extra-field') Object.assign(snapshot, { writer: 'unexpected' });
    if (kind === 'runtime') snapshot.runtime = null;
    if (kind === 'tag-arity') row('operation').value = ['undefined', 'ignored'];
    if (kind === 'duplicate-entry') snapshot.entries.push(snapshot.entries[0]);
    if (kind === 'unknown-port') row('policy').key = JSON.stringify(['writer', ['undefined']]);
    if (kind === 'state-omission') snapshot.entries = snapshot.entries.filter(entry => entry !== row('state'));
    if (kind === 'state-count') snapshot.stateCounts[0][1] = 2;
    if (kind === 'extra-state') snapshot.stateCounts[0][1] = 0;
    if (kind === 'missing-clock') snapshot.entries = snapshot.entries.filter(entry => entry !== row('app.now'));
    if (kind === 'missing-evidence') {
      f.options.convergence[0].evidenceRefs = [];
      const noEvidence = ['array', [['object', [['args', JSON.parse(row('convergence').key)[1]],
        ['evidenceRefs', ['array', []]], ['result', false]]]]];
      snapshot.convergence = noEvidence as typeof snapshot.convergence;
    }
    if (kind === 'convergence-result') row('convergence').value = true;
    if (kind === 'organization-installation') snapshot.organizationInstalled = false;
    // Independent canonical JSON writer, not the replay implementation's hasher.
    const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` :
      value !== null && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}` : JSON.stringify(value);
    expect(() => replayIdopP001KernelPermissionSnapshot(snapshot, sha256(canonical(snapshot))))
      .toThrow(/IDOP.*(malformed|not captured)/);
  });

  it('refuses uncaptured privileges, principals, original runs, arguments and phases', async () => {
    const f = fixture();
    const { inner } = (await captureIdopP001KernelPermissionPorts(f.options, f.readers)).createPorts();
    for (const change of [{ isSuperuser: false }, { role: 'judge' }, { uiClientId: 'other-owner' }, { runId: 'other-run' },
      { principal: { ...f.request.ctx.principal!, capabilities: new Set(['forged:*']) } }]) {
      const ctx = { ...f.request.ctx, ...change } as UnifiedToolContext;
      expect(() => inner.resolveIdentity(ctx)).toThrow(/not captured/);
      await expect(inner.readState({ ...f.request, ctx })).rejects.toThrow(/not captured/);
    }
    await expect(inner.readState({ ...f.request, args: { target: 'forged' } })).rejects.toThrow(/not captured/);
    await expect(inner.readState({ ...f.request, phase: 'preflight' })).rejects.toThrow(/not captured/);
    expect(await inner.readState(f.request)).toEqual({ revoked: true });
  });

  it('refuses uncaptured app, clock, organization, policy, catalog, operation and plan authority or a writer', async () => {
    const f = fixture();
    const { inner, app, organization } = (await captureIdopP001KernelPermissionPorts(f.options, f.readers)).createPorts();
    await expect(app.loadRow('forged')).rejects.toThrow(/not captured/);
    await expect(app.loadAccessTokenRow('forged', 'original-app')).rejects.toThrow(/not captured/);
    await expect(app.loadSpendStatus('original-app', new Date(0))).rejects.toThrow(/not captured/);
    expect(() => app.lookupTool('forged')).toThrow(/not captured/);
    expect(() => inner.resolveTool('forged')).toThrow(/not captured/);
    await expect(organization!.loadChain('foreign')).rejects.toThrow(/not captured/);
    await expect(inner.readPolicy({ ...f.policyInput, role: 'judge' })).rejects.toThrow(/not captured/);
    await expect(inner.readOperationEffectClaim({ ...f.claim, ownerId: 'forged' })).rejects.toThrow(/not captured/);
    await expect(inner.plan.readBindings('forged', 'kernel-workspace')).rejects.toThrow(/not captured/);
    await expect(inner.plan.resolveGoal('original-owner', 'foreign')).rejects.toThrow(/not captured/);
    await expect(inner.plan.checkPlan({ ...f.binding, planSlug: 'forged' }, 'kernel-workspace')).rejects.toThrow(/not captured/);
    const args = [...f.options.convergence[0].args] as typeof f.options.convergence[0]['args'];
    args[0] = 'forged';
    await expect(inner.converge(...args)).rejects.toThrow(/not captured/);
    await expect(inner.converge(...f.options.convergence[0].args, {} as never)).rejects.toThrow(/writer/);
  });

  it('keeps absent organization installation distinct from an installed empty chain', async () => {
    const f = fixture();
    const absent = await captureIdopP001KernelPermissionPorts(f.options, { ...f.readers, organization: null });
    expect(absent.snapshot.organizationInstalled).toBe(false);
    expect(absent.createPorts().organization).toBeNull();
    expect(f.readers.organization!.loadChain).not.toHaveBeenCalled();
    const installed = await captureIdopP001KernelPermissionPorts(f.options, f.readers);
    expect(installed.sha256).not.toBe(absent.sha256);
  });

  it.each([0, 1])('wires the captured ports into canonical outer and inner source readers (arm %i)', async arm => {
    const revision = arm === 0 ? baseline.base.commit : 'working-tree';
    const policy = loadIdopP001RolePermissionReader({ root, revision, testingFullAccess: 'off' });
    const generic = await loadIdopP001DispatchPermissionReader({ root, revision });
    for (const principal of ['application', 'session'] as const) {
      const f = fixture();
      if (principal === 'session') delete f.request.ctx.principal;
      const captured = await captureIdopP001KernelPermissionPorts(f.options, f.readers);
      const replay = captured.createPorts();
      const inner = await policy.createInnerKernelReader(replay.inner);
      const structural = policy.createStructuralKernelReader({ resolveIdentity: replay.inner.resolveIdentity,
        sameKernelRevision: generic.sameKernelRevision });
      const outer = policy.createOuterKernelReader({ app: replay.app, organization: replay.organization,
        resolveControlAnchor: inner.evaluate, structural: request => structural(request, request.ctx.kernelState) });
      expect(await outer(f.request)).toMatchObject({ decision: 'deny',
        code: principal === 'application' ? 'app_scope:key_unknown' : 'revoked' });
      expect(f.readers.inner.readState).toHaveBeenCalledOnce();
      expect(f.readers.app.loadRow).toHaveBeenCalledOnce();
      expect(f.readers.organization!.loadChain).toHaveBeenCalledOnce();
    }
  }, 60_000);

  it('copies canonical tool names and refuses executable registry metadata', async () => {
    const f = fixture();
    const handler = vi.fn();
    vi.mocked(f.readers.inner.resolveTool).mockReturnValue({ pluginName: 'comparison', description: 'Original tool metadata',
      inputSchema: { type: 'object' }, capabilities: ['mail:send'], expose: { mcp: { name: 'mail:send' } }, fn: handler });
    const { inner } = (await captureIdopP001KernelPermissionPorts(f.options, f.readers)).createPorts();
    expect(inner.resolveTool('mail:send')!.expose.mcp!.name).toBe('mail:send');
    expect(() => inner.resolveTool('mail:send')!.fn).toThrow(/metadata was not captured/);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['foreign-request', 'foreign-policy', 'foreign-claim', 'missing-tool', 'duplicate-request',
    'unbounded-state', 'missing-convergence-evidence', 'foreign-convergence'])('rejects %s capture', async kind => {
    const f = fixture();
    if (kind === 'foreign-request') f.request.ctx.workspaceId = 'foreign';
    if (kind === 'foreign-policy') f.policyInput.workspaceId = 'foreign';
    if (kind === 'foreign-claim') f.claim.workspaceId = 'foreign';
    if (kind === 'missing-tool') f.options.toolNames = [];
    if (kind === 'duplicate-request') f.options.requests = [f.options.requests[0], f.options.requests[0]];
    if (kind === 'unbounded-state') f.options.requests[0].stateReadCount = Infinity;
    if (kind === 'missing-convergence-evidence') f.options.convergence[0].evidenceRefs = [];
    if (kind === 'foreign-convergence') f.options.convergence[0].args[1] = 'foreign';
    await expect(captureIdopP001KernelPermissionPorts(f.options, f.readers)).rejects.toThrow(/IDOP/);
  });

  it('refuses lossy values, accessors, executable data and reader mutation; propagates original read failures', async () => {
    for (const value of [() => true, new (class {})(), new Date(NaN),
      Object.defineProperty({}, 'hidden', { get() { throw new Error('getter ran'); } }),
      Object.assign(new Map(), { extra: 'not captured' }), Array(1)]) {
      const f = fixture();
      // Deliberately unsupported runtime values exercise data-only rejection.
      vi.mocked(f.readers.inner.readState).mockResolvedValue(value);
      await expect(captureIdopP001KernelPermissionPorts(f.options, f.readers)).rejects.toThrow(/IDOP authority/);
    }
    const f = fixture();
    vi.mocked(f.readers.inner.readState).mockImplementation(async () => { f.request.toolName = 'forged'; return null; });
    await expect(captureIdopP001KernelPermissionPorts(f.options, f.readers)).rejects.toThrow(/mutated/);
    const failure = fixture();
    vi.mocked(failure.readers.inner.readPolicy).mockRejectedValue(new Error('original policy unreadable'));
    await expect(captureIdopP001KernelPermissionPorts(failure.options, failure.readers)).rejects.toThrow('original policy unreadable');
  });
});

describe('IDOP D-043 canonical inner control and identity authority', () => {
  let policies: ReturnType<typeof loadIdopP001RolePermissionReader>[];
  const request = (over: Partial<KernelEnforcementRequest> = {}): KernelEnforcementRequest => ({
    phase: 'enforce', boundary: 'dispatch', toolName: 'mail:send', capabilities: ['mail:send'], args: {},
    ctx: { workspaceId: 'comparison-workspace', role: 'worker', isSuperuser: true, uiClientId: 'original-owner',
      log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
      runId: 'original-run', spawnId: 'original-spawn' }, ...over,
  });
  const ports = (state: Awaited<ReturnType<IdopInnerKernelPorts['readState']>> = null): IdopInnerKernelPorts => ({
    readState: vi.fn(async () => state),
    resolveIdentity: vi.fn(() => ({ ownerId: 'original-owner', workspaceId: 'comparison-workspace' })),
    readPolicy: vi.fn(async () => { throw new Error('policy not captured'); }),
    readOperationEffectClaim: vi.fn(async () => false), resolveTool: vi.fn(() => undefined),
    runtime: { pid: 12345, processId: 'original-process' },
    converge: vi.fn(async () => false),
    plan: { readBindings: vi.fn(async () => []), resolveGoal: vi.fn(async () => ({ goal: null, diagnostics: [] })),
      checkPlan: vi.fn(async () => []) },
  });
  beforeAll(() => {
    policies = [baseline.base.commit, 'working-tree'].map(revision =>
      loadIdopP001RolePermissionReader({ root, revision, testingFullAccess: 'off' }));
  });

  it.each([0, 1])('preserves original host state and refuses unavailable or revoked authority before SU (arm %i)', async arm => {
    const input = ports({ revoked: true });
    const inner = await policies[arm].createInnerKernelReader(input);
    const req = request();
    expect(await inner.evaluate(req)).toMatchObject({ decision: 'deny', code: 'revoked' });
    expect(vi.mocked(input.readState).mock.calls.at(-1)![0]).toBe(req);
    vi.mocked(input.readState).mockRejectedValue(Object.assign(new Error('private SQL must not leak'), { code: '08006' }));
    const refused = await inner.evaluate(req);
    expect(refused).toMatchObject({ decision: 'deny', code: 'policy-unavailable',
      serverAudit: { authorityUnavailableSources: ['authority-reader-initialization-failed'],
        authorityReadFailures: [{ pgCode: '08006', servingPid: 12345, servingProcessId: 'original-process' }] } });
    expect(JSON.stringify(refused)).not.toContain('private SQL');
    expect(input.readPolicy).not.toHaveBeenCalled();
    expect(input.converge).not.toHaveBeenCalled();
  }, 60_000);

  it.each([0, 1])('keeps the missing-launch-record recovery door and its no-grants verdict (arm %i)', async arm => {
    const input = ports({ identityLaunchRecord: null, identityLaunchRecordMissing: true,
      activation: { applied: { specificationRevision: 'a'.repeat(64), stateRevision: 'original-state' } } });
    const inner = await policies[arm].createInnerKernelReader(input);
    expect(await inner.evaluate(request())).toMatchObject({ decision: 'deny', code: 'capability_unsatisfied',
      obligations: { capabilityUnsatisfied: { cause: 'no-launch-record' } } });
    expect(await inner.evaluate(request({ toolName: 'coord:orient' })))
      .toMatchObject({ decision: 'allow', applied: false, code: 'identity-recovery' });
    expect(input.readPolicy).not.toHaveBeenCalled();
  }, 60_000);

  const governed = () => {
    const classRef = 'comparison.mail@1.0.0';
    const pin = { kind: 'capability-provider' as const, ref: classRef, providerPackage: 'mail-provider',
      providerVersion: '1.0.0', registryRevision: 'original-registry', conformanceRunId: 'original-run',
      verbBindings: { send: 'mail:send' } };
    const artifact = compileAgentSpecification({ source: { id: 'comparison-grant', workItem: { kind: 'feature' },
      spine: { edges: { DONE: { to: 'done' } } }, grants: { requires: [classRef] } },
      prompt: { role: 'worker', text: 'Original authority.' }, inputClosure: [pin] });
    const applied = { specificationRevision: artifact.specificationRevision, stateRevision: 'original-state' };
    const state = { activation: { applied }, operationOwnerId: 'original-owner',
      identityLaunchRecordVersion: { sessionId: 'original-session', rowVersion: 'original-xmin' },
      identityLaunchRecord: { workspaceId: 'comparison-workspace', harnessSlug: 'papercusp',
        ...applied, specificationArtifact: artifact } };
    const policy: Awaited<ReturnType<IdopInnerKernelPorts['readPolicy']>> = {
      policyRevision: 'original-policy', potSlug: 'papercusp', ceilings: [{ allowCapabilities: ['mail:send'] }],
      protectedAdditions: [], tools: new Map([['mail:send', ['mail:send']]]),
      bindings: [{ ...pin, classRef, potSlug: 'papercusp', status: 'active', conformanceStatus: 'passed',
        behavioralStatus: 'not-required', behavioralRunRef: null, boundBy: 'original-admin',
        boundAt: '2026-11-16', updatedAt: '2026-11-16' }],
    };
    return { state, policy };
  };

  it('refuses uncaptured launch-model reads at the adapter boundary despite canonical error conversion', async () => {
    const artifact = compileAgentSpecification({ source: { id: 'comparison-model', workItem: { kind: 'feature' },
      spine: { edges: { DONE: { to: 'done' } } }, roles: [{ id: 'worker', backend: 'codex', model: 'gpt-6-sol' }] },
      prompt: { role: 'worker', text: 'Original launch model.' } });
    const generic = await loadIdopP001DispatchPermissionReader({ root, revision: 'working-tree', includeIdentityReplay: true });
    expect(() => generic.replayAgentSpecification!(artifact)).toThrow(/uncaptured filesystem/);
    const plain = governed().state.identityLaunchRecord.specificationArtifact;
    expect(generic.replayAgentSpecification!(plain).specificationRevision).toBe(plain.specificationRevision);
  }, 60_000);

  it.each([0, 1])('replays pinned artifacts and rechecks current policy on each boundary, including SU (arm %i)', async arm => {
    const f = governed();
    const generic = await loadIdopP001DispatchPermissionReader({ root,
      revision: arm === 0 ? baseline.base.commit : 'working-tree', includeIdentityReplay: true });
    expect(generic.replayAgentSpecification!(f.state.identityLaunchRecord.specificationArtifact).specificationRevision)
      .toBe(f.state.identityLaunchRecord.specificationRevision);
    expect(() => generic.replayAgentSpecification!({ ...f.state.identityLaunchRecord.specificationArtifact,
      specificationRevision: 'f'.repeat(64) })).toThrow(/mismatch/);
    const input = ports(f.state);
    vi.mocked(input.readPolicy).mockResolvedValue(f.policy);
    const inner = await policies[arm].createInnerKernelReader(input);
    expect(inner.genericSources.some(s => s.path.endsWith('/blueprint/composition-compiler.ts'))).toBe(true);
    for (const phase of ['preflight', 'enforce'] as const) {
      expect(await inner.evaluate(request({ phase }))).toMatchObject({ decision: 'allow',
        policyRevision: 'original-policy', serverAudit: { identityLaunchRecord: {
          advSessionId: 'original-session', xmin: 'original-xmin' } } });
      f.policy.ceilings = [{ denyCapabilities: ['mail:send'] }];
      expect(await inner.evaluate(request({ phase }))).toMatchObject({ decision: 'deny',
        obligations: { capabilityUnsatisfied: { cause: 'outside-ceiling' } } });
      f.policy.ceilings = [{ allowCapabilities: ['mail:send'] }];
    }
    expect(input.readPolicy).toHaveBeenCalledTimes(4);
    expect(input.readPolicy).toHaveBeenLastCalledWith({ workspaceId: 'comparison-workspace',
      harnessSlug: 'papercusp', role: 'worker', classRefs: ['comparison.mail@1.0.0'] });
  }, 60_000);

  it.each([0, 1])('checks original accepted-operation claims and never trusts forged request arguments (arm %i)', async arm => {
    const f = governed();
    const acceptedOperation = { kind: 'blueprint-operation-worker', workItemId: 'WI-original', operationId: 'send',
      specificationRevision: 'b'.repeat(64), requiredTools: ['mail:send'],
      pin: { kind: 'blueprint-operation', harnessSlug: 'papercusp', operationId: 'send',
        specificationRevision: 'b'.repeat(64), operationVersion: '1.0.0', input: {} } };
    const input = ports({ ...f.state, identityLaunchRecord: { ...f.state.identityLaunchRecord, acceptedOperation } });
    vi.mocked(input.readPolicy).mockResolvedValue(f.policy);
    const inner = await policies[arm].createInnerKernelReader(input);
    const req = request({ args: { ownerId: 'forged', workItemId: 'WI-forged', acceptedOperation: null } });
    expect(await inner.evaluate(req)).toMatchObject({ decision: 'deny', code: 'operation-claim-stale' });
    expect(input.readOperationEffectClaim).toHaveBeenLastCalledWith({ workspaceId: 'comparison-workspace',
      harnessSlug: 'papercusp', workItemId: 'WI-original', ownerId: 'original-owner',
      advSessionId: 'original-session', acceptedOperation });
    vi.mocked(input.readOperationEffectClaim).mockResolvedValue(true);
    expect(await inner.evaluate(req)).toMatchObject({ decision: 'allow' });
    vi.mocked(input.readOperationEffectClaim).mockRejectedValue(new Error('claim unavailable'));
    expect(await inner.evaluate(req)).toMatchObject({ decision: 'deny', code: 'operation-claim-unavailable' });
  }, 60_000);

  it('retains the real old/current plan-guard difference and original owner bindings', async () => {
    const input = ports();
    input.plan.readBindings = vi.fn(async () => [{ planSlug: 'original-plan', harnessSlug: 'papercusp' }]);
    input.plan.checkPlan = vi.fn(async () => ['original-not-started']);
    const req = request({ toolName: 'capability:edit', args: { path: '/original/file' } });
    const old = await policies[0].createInnerKernelReader(input);
    expect(old.hasPlanGuard).toBe(false);
    expect(await old.evaluate(req)).toMatchObject({ decision: 'allow' });
    expect(input.plan.readBindings).not.toHaveBeenCalled();
    const current = await policies[1].createInnerKernelReader(input);
    expect(current.hasPlanGuard).toBe(true);
    expect(await current.evaluate({ ...req, phase: 'preflight' })).toMatchObject({ decision: 'allow' });
    expect(input.plan.readBindings).not.toHaveBeenCalled();
    expect(await current.evaluate(req)).toMatchObject({ decision: 'deny', code: 'plan_execution_not_ready',
      obligations: { planExecution: { blockers: ['original-not-started'] } } });
    expect(input.plan.readBindings).toHaveBeenLastCalledWith('original-owner', 'comparison-workspace');
    vi.mocked(input.plan.checkPlan).mockResolvedValue([]);
    expect(await current.evaluate(req)).toMatchObject({ decision: 'allow' });
  }, 60_000);

  it.each([0, 1])('re-reads original state only after captured convergence succeeded (arm %i)', async arm => {
    const f = governed();
    const stale = { identityLaunchRecord: null, operationOwnerId: 'original-owner',
      operationWorkspaceId: 'comparison-workspace', controlGeneration: 7,
      activation: { applied: { specificationRevision: 'a'.repeat(64), stateRevision: 'stale-state' },
        desired: f.state.activation.applied } };
    const failed = ports(stale);
    const closed = await policies[arm].createInnerKernelReader(failed);
    expect(await closed.evaluate(request())).toMatchObject({ decision: 'deny',
      obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } } });
    expect(failed.readState).toHaveBeenCalledOnce();
    expect(failed.converge).toHaveBeenCalledWith('original-owner', 'comparison-workspace', 7, f.state.activation.applied);

    const success = ports(stale);
    vi.mocked(success.readState).mockResolvedValueOnce(stale).mockResolvedValueOnce(f.state);
    vi.mocked(success.readPolicy).mockResolvedValue(f.policy);
    vi.mocked(success.converge).mockResolvedValue(true);
    const healed = await policies[arm].createInnerKernelReader(success);
    expect(await healed.evaluate(request())).toMatchObject({ decision: 'allow', policyRevision: 'original-policy' });
    expect(success.readState).toHaveBeenCalledTimes(2);
    expect(success.converge).toHaveBeenCalledOnce();
  }, 60_000);

  it('keeps the full original plan census when goal selection is degraded and refuses forged binding goals', async () => {
    const input = ports();
    input.plan.readBindings = vi.fn(async () => [
      { planSlug: 'selected-plan', harnessSlug: 'papercusp', source: 'work-item' as const, sourceRef: 'WI-selected' },
      { planSlug: 'other-plan', harnessSlug: 'papercusp', source: 'work-item' as const, sourceRef: 'WI-other' },
    ]);
    input.plan.resolveGoal = vi.fn(async () => ({ goal: null, diagnostics: ['unavailable'] }));
    input.plan.checkPlan = vi.fn(async binding => binding.planSlug === 'other-plan' ? ['other-not-started'] : []);
    const inner = await policies[1].createInnerKernelReader(input);
    const req = request({ toolName: 'capability:edit', args: { goal: 'WI-selected', planSlug: 'selected-plan' } });
    expect(await inner.evaluate(req)).toMatchObject({ decision: 'deny', obligations: {
      planExecution: { planSlug: 'other-plan', blockers: ['other-not-started'] } } });
    expect(input.plan.checkPlan).toHaveBeenCalledTimes(2);
    expect(input.plan.resolveGoal).toHaveBeenCalledWith('original-owner', 'comparison-workspace',
      expect.any(Function), expect.any(AbortSignal));
    vi.mocked(input.plan.readBindings).mockRejectedValue(new Error('binding authority unavailable'));
    expect(await inner.evaluate(req)).toMatchObject({ decision: 'deny', obligations: {
      planExecution: { blockers: ['plan_authority_unavailable'] } } });
  }, 60_000);

  it('requires explicit authority ports, even when a fixture has no identity or plan', async () => {
    await expect(policies[1].createInnerKernelReader({ ...ports(), readPolicy: undefined! }))
      .rejects.toThrow(/explicit authority readers/);
  });
});

describe('IDOP D-043 canonical pinned dispatch adapter', () => {
  let readers: Awaited<ReturnType<typeof loadIdopP001DispatchPermissionReader>>[];
  let policies: ReturnType<typeof loadIdopP001RolePermissionReader>[];
  beforeAll(async () => {
    readers = await Promise.all([baseline.base.commit, 'working-tree'].map(revision =>
      loadIdopP001DispatchPermissionReader({ root, revision })));
    policies = [baseline.base.commit, 'working-tree'].map(revision =>
      loadIdopP001RolePermissionReader({ root, revision, testingFullAccess: 'off' }));
  }, 60_000);
  const context = (): UnifiedToolContext => ({
    log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
    workspaceId: 'comparison-workspace', harnessSlug: 'papercusp', role: 'worker',
    runId: 'original-run', chunkId: 'original-chunk', spawnId: 'original-spawn', parentSpawnId: null,
  });
  const tool = (over: Partial<ProjectedTool> = {}): ProjectedTool => ({
    pluginName: 'comparison', description: 'Public comparison fixture', inputSchema: { type: 'object' },
    capabilities: [], expose: { mcp: { name: 'comparison:probe' } }, fn: vi.fn(), ...over,
  });
  const ports = (over: Partial<IdopHostPermissionPorts> = {}): IdopHostPermissionPorts => ({
    resolveConfinement: vi.fn(async () => null), ensureConfinementReady: vi.fn(async () => {}),
    audit: { resolveIdentity: vi.fn(() => ({ ownerId: 'original-owner', workspaceId: 'comparison-workspace' })),
      readModes: vi.fn(async () => []) },
    roleOverrides: vi.fn(() => ({})), protectedAdditions: vi.fn(() => []), getFlag: vi.fn(async () => true), ...over,
  });

  it.each([0, 1])('runs captured host inputs through the canonical dispatcher without live authority reads (arm %i)', async arm => {
    const source = ports();
    const original = context();
    const captured = await captureIdopP001HostPermissionPorts({ workspaceId: 'comparison-workspace',
      contexts: [original], flags: [{ key: 'papercusp-capability-envelope', distinctId: 'system' }] },
    { ...source, readFlagAttestation: async () => hostFlagAttestation() });
    vi.mocked(source.audit.readModes).mockRejectedValue(new Error('later host read must not run'));
    vi.mocked(source.roleOverrides).mockImplementation(() => { throw new Error('later override read must not run'); });
    const handler = vi.fn();
    const gate = policies[arm].createHostEnvelopePort(captured.ports);
    const evaluate = (capabilities: string[]) => readers[arm].evaluate(tool({ fn: handler, capabilities }),
      'comparison:probe', {}, context(), { checkCapabilityEnvelope: gate });
    expect(await evaluate(['secrets:read'])).toMatchObject({ allowed: false, error: { code: 'capability_denied' } });
    expect(await evaluate(['capability:read'])).toEqual({ allowed: true });
    expect(source.resolveConfinement).toHaveBeenCalledTimes(1);
    expect(source.audit.readModes).toHaveBeenCalledTimes(1);
    expect(source.getFlag).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([0, 1])('wires canonical host enforcement, observe mode, role overrides and protected additions into dispatch (arm %i)', async arm => {
    const hostPorts = ports();
    const gate = policies[arm].createHostEnvelopePort(hostPorts);
    const fixture = tool({ capabilities: ['secrets:read'] });
    const evaluate = () => readers[arm].evaluate(fixture, 'comparison:probe', {}, context(), { checkCapabilityEnvelope: gate });
    expect(await evaluate()).toMatchObject({ allowed: false, error: { code: 'capability_denied' } });
    expect(hostPorts.getFlag).toHaveBeenLastCalledWith('papercusp-capability-envelope', 'system');
    vi.mocked(hostPorts.getFlag).mockResolvedValue(false);
    expect(await evaluate()).toEqual({ allowed: true });
    vi.mocked(hostPorts.getFlag).mockResolvedValue(true);
    const ordinary = tool({ capabilities: ['capability:read'] });
    const read = () => readers[arm].evaluate(ordinary, 'comparison:probe', {}, context(), { checkCapabilityEnvelope: gate });
    expect(await read()).toEqual({ allowed: true });
    vi.mocked(hostPorts.roleOverrides).mockReturnValue({ worker: { denyCapabilities: ['capability:read'] } });
    expect(await read()).toMatchObject({ allowed: false });
    vi.mocked(hostPorts.roleOverrides).mockReturnValue({});
    expect(await read()).toEqual({ allowed: true });
    vi.mocked(hostPorts.protectedAdditions).mockReturnValue(['capability:read']);
    expect(await read()).toMatchObject({ allowed: false });
  });

  it.each([0, 1])('binds ORIGINAL assignment arguments before SU exemption without invoking handlers (arm %i)', async arm => {
    const handler = vi.fn();
    const hostPorts = ports({ resolveConfinement: vi.fn(async () => ({
      denyTools: [], denyOutside: ['work_items:get'],
      denyWorkItemsOutside: { id: 'F-own', harness: 'comparison-workspace', checkout: root },
      imposedBy: 'original-launcher', reason: 'same original assignment',
    })) });
    const gate = policies[arm].createHostEnvelopePort(hostPorts);
    const original = { ...context(), uiClientId: 'original-owner', isSuperuser: true };
    const fixture = tool({ fn: handler });
    const deps = { checkCapabilityEnvelope: gate, recordInvocation: vi.fn(), postInvoke: vi.fn() };
    const evaluate = (id: string) => readers[arm].evaluate(fixture, 'work_items:get',
      { id, harness: 'comparison-workspace' }, original, deps);
    expect(await evaluate('F-own')).toEqual({ allowed: true });
    expect(await evaluate('F-other')).toMatchObject({ allowed: false, error: { code: 'capability_denied' } });
    expect(await readers[arm].evaluate(fixture, 'work_items:get', {
      id: 'F-other', harness: 'comparison-workspace', confinement: null, isSuperuser: true,
    }, original, deps)).toMatchObject({ allowed: false });
    for (const [ctx] of vi.mocked(hostPorts.resolveConfinement).mock.calls) expect(ctx).toMatchObject({
      uiClientId: 'original-owner', runId: 'original-run', spawnId: 'original-spawn',
    });
    expect(hostPorts.roleOverrides).toHaveBeenCalledTimes(1); // only the allowed assignment falls through
    expect(hostPorts.getFlag).not.toHaveBeenCalled();
    for (const effect of [handler, deps.recordInvocation, deps.postInvoke]) expect(effect).not.toHaveBeenCalled();
  });

  it.each([0, 1])('enforces canonical AUDIT before SU exemption and retains a positive read control (arm %i)', async arm => {
    const hostPorts = ports();
    vi.mocked(hostPorts.audit.readModes).mockResolvedValue([{ mode: 'audit' }]);
    const gate = policies[arm].createHostEnvelopePort(hostPorts);
    const ctx = { ...context(), isSuperuser: true };
    expect(await readers[arm].evaluate(tool(), 'work_items:complete', {}, ctx, { checkCapabilityEnvelope: gate }))
      .toMatchObject({ allowed: false, error: { code: 'capability_denied', message: expect.stringContaining('AUDIT mode') } });
    expect(hostPorts.audit.readModes).toHaveBeenCalledWith('comparison-workspace', 'original-owner');
    expect(hostPorts.roleOverrides).not.toHaveBeenCalled();
    expect(await readers[arm].evaluate(tool(), 'work_items:get', {}, ctx, { checkCapabilityEnvelope: gate }))
      .toEqual({ allowed: true });
  });

  it.each([0, 1])('fails closed on unreadable confinement and requires explicit authority readers (arm %i)', async arm => {
    const hostPorts = ports({ ensureConfinementReady: vi.fn(async () => { throw new Error('unavailable authority'); }) });
    const gate = policies[arm].createHostEnvelopePort(hostPorts);
    expect(await readers[arm].evaluate(tool(), 'comparison:probe', {}, { ...context(), isSuperuser: true },
      { checkCapabilityEnvelope: gate })).toMatchObject({ allowed: false,
      error: { code: 'capability_denied', message: expect.stringContaining('policy is unavailable') } });
    expect(hostPorts.resolveConfinement).not.toHaveBeenCalled();
    expect(hostPorts.roleOverrides).not.toHaveBeenCalled();
    expect(() => policies[arm].createHostEnvelopePort({ ...hostPorts, getFlag: undefined } as never))
      .toThrow(/every authority read port/);
  });

  it.each([0, 1])('records the actual selected host declarations and full source bytes (arm %i)', arm => {
    policies[arm].createHostEnvelopePort(ports());
    expect(policies[arm].hostFunctions.map(row => row.name).sort())
      .toEqual(['checkCapabilityEnvelopeImpl', 'checkSessionConfinement']);
    for (const row of policies[arm].hostFunctions) expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
    for (const source of policies[arm].sources) {
      const expected = arm === 1 ? readFileSync(join(root, source.path)) :
        execFileSync('git', ['-C', root, 'show', `${baseline.base.commit}:${source.path}`]);
      expect(source.sha256).toBe(sha256(expected));
    }
  });

  it('binds both canonical dispatch sources to their actual gitlinks and source bytes', () => {
    expect(readers[0].sources).toContainEqual(expect.objectContaining({
      path: 'libs/generic/tooldef/src/dispatch-stack.ts', revision: 'c3376b4e6f887e664f626471aa63461a89bdd5c4',
    }));
    for (const source of readers[1].sources) expect(source.sha256).toBe(sha256(readFileSync(join(root, source.path))));
    expect(readers[0].externalDependencies).toEqual(readers[1].externalDependencies);
    expect(readers[0].externalDependencies.map(entry => entry.name)).toEqual(['mingo', 'zod', 'zod-to-json-schema']);
  });

  const structuralRequest = (): KernelEnforcementRequest => ({ phase: 'preflight', boundary: 'dispatch',
    toolName: 'comparison:probe', capabilities: [], args: {}, ctx: context() });
  const structuralReader = (arm: number) => policies[arm].createStructuralKernelReader({
    resolveIdentity: () => ({ ownerId: 'original-owner', workspaceId: 'comparison-workspace' }),
    sameKernelRevision: readers[arm].sameKernelRevision,
  });

  const outerPorts = () => ({
    app: {
      loadRow: vi.fn(async () => ({ id: 'comparison-app', workspace_id: 'comparison-workspace',
        scopes: { tools: ['comparison:probe'], capabilities: [], harnesses: ['papercusp'] },
        revoked_at: null, paused_at: null, expires_at: null })),
      loadAccessTokenRow: vi.fn(async () => null),
      lookupTool: vi.fn((name: string) => ({ name, capabilities: [] })),
      loadSpendStatus: vi.fn(async () => ({ capCents: null, spentCents: 0, windowSec: null })),
      now: () => new Date('2026-11-16T09:00:00Z'),
    },
    organization: { loadChain: vi.fn(async () => ({ status: 'none' as const })),
      now: () => new Date('2026-11-16T09:00:00Z') },
    resolveControlAnchor: vi.fn(async () => ({ decision: 'allow' as const, availability: 'available' as const,
      applied: true, policyRevision: 'saved-control-anchor' })),
    structural: vi.fn(async () => ({ decision: 'deny' as const, availability: 'available' as const,
      applied: true, code: 'structural-fixture' })),
  });

  it.each([0, 1])('runs canonical app and organization guards before the supplied inner resolver (arm %i)', async arm => {
    const ports = outerPorts();
    const outer = policies[arm].createOuterKernelReader(ports);
    const request = structuralRequest();
    expect(await outer(request)).toMatchObject({ decision: 'allow', policyRevision: 'saved-control-anchor' });
    expect(ports.organization.loadChain).toHaveBeenCalledWith('comparison-workspace');
    expect(ports.resolveControlAnchor).toHaveBeenCalledWith(request);
    expect(ports.app.loadRow).not.toHaveBeenCalled();
    expect(ports.structural).not.toHaveBeenCalled();
    const sourceNames = policies[arm].hostFunctions.map(row => row.name);
    expect(sourceNames).toEqual(expect.arrayContaining(['operatorKernelEnforcement', 'enforceAppKeyScope',
      'enforceInheritedPolicy', 'workspacePolicyJudge']));
  });

  it.each([0, 1])('keeps app native, workspace and token refusals ahead of organization or inner policy (arm %i)', async arm => {
    const ports = outerPorts();
    const outer = policies[arm].createOuterKernelReader(ports);
    const request = structuralRequest();
    request.ctx.principal = { kind: 'service', slug: 'app:comparison-app', trust: 'verified', authMethod: 'bearer-token',
      capabilities: new Set<string>(), workspaceId: 'comparison-workspace' };
    expect(await outer({ ...request, boundary: 'shell' })).toMatchObject({ decision: 'deny', code: 'app_scope:hard_denied' });
    expect(await outer({ ...request, ctx: { ...request.ctx, workspaceId: 'foreign' } }))
      .toMatchObject({ decision: 'deny', code: 'app_scope:workspace_mismatch' });
    request.ctx.principal = { ...request.ctx.principal, slug: 'app:comparison-app/missing-token' };
    expect(await outer(request)).toMatchObject({ decision: 'deny', code: 'app_scope:key_unknown' });
    expect(ports.organization.loadChain).not.toHaveBeenCalled();
    expect(ports.resolveControlAnchor).not.toHaveBeenCalled();
  });

  it.each([0, 1])('preserves inherited policy refusal and unreadable authority in both phases (arm %i)', async arm => {
    const ports = outerPorts();
    const outer = policies[arm].createOuterKernelReader({ ...ports, organization: {
      now: ports.organization.now,
      loadChain: async () => ({ status: 'ok', chain: [{ layerId: 'original-org', level: 'organization',
        version: 1, rules: { tools: { deny: ['comparison:*'] } }, scopeRef: 'original-organization',
        parentLayerId: null, contentHash: 'a'.repeat(64), updatedBy: 'original-admin',
        updatedAt: '2026-11-16T08:00:00Z' }] }),
    } });
    for (const phase of ['preflight', 'enforce'] as const) {
      expect(await outer({ ...structuralRequest(), phase })).toMatchObject({ decision: 'deny', policyRevision: 'original-org@v1' });
    }
    const unavailable = policies[arm].createOuterKernelReader({ ...ports, organization: {
      now: ports.organization.now, loadChain: async () => { throw new Error('original authority unavailable'); },
    } });
    expect(await unavailable(structuralRequest())).toMatchObject({ decision: 'deny', code: 'org_policy:unavailable' });
    expect(ports.resolveControlAnchor).not.toHaveBeenCalled();
  });

  it.each([0, 1])('runs the allowed app path and spending cap without invoking alert writers (arm %i)', async arm => {
    const ports = outerPorts();
    const request = structuralRequest();
    request.ctx.principal = { kind: 'service', slug: 'app:comparison-app', trust: 'verified', authMethod: 'bearer-token',
      capabilities: new Set<string>(), workspaceId: 'comparison-workspace' };
    const row = await ports.app.loadRow();
    row.scopes.tools.push('blueprint:submit');
    ports.app.loadRow.mockResolvedValue(row);
    let spentCents = 99;
    const outer = policies[arm].createOuterKernelReader({ ...ports, app: { ...ports.app,
      loadSpendStatus: async () => ({ capCents: 100, spentCents, windowSec: null }),
      // Extra writer fields must never leak into the comparison's read deps.
      ...{ raiseAlert: () => { throw new Error('must not send alerts'); },
        loadAlertedApp: () => { throw new Error('must not read alert payloads'); } },
    } });
    expect(await outer(request)).toMatchObject({ decision: 'allow', policyRevision: 'saved-control-anchor' });
    expect(await outer({ ...request, toolName: 'blueprint:submit' })).toMatchObject({ decision: 'allow' });
    const before = ports.resolveControlAnchor.mock.calls.length;
    spentCents = 100;
    expect(await outer({ ...request, toolName: 'blueprint:submit' }))
      .toMatchObject({ decision: 'deny', code: 'app_scope:spend_cap_reached' });
    expect(ports.resolveControlAnchor).toHaveBeenCalledTimes(before);
    expect(policies[arm].disabledHostPorts).toContain('connected-apps.raiseAlert');
  });

  it.each([0, 1])('requires explicit host installation state and preserves structural fallback (arm %i)', async arm => {
    const ports = outerPorts();
    expect(() => policies[arm].createOuterKernelReader({ ...ports, resolveControlAnchor: undefined! }))
      .toThrow(/explicit/);
    expect(() => policies[arm].createOuterKernelReader({ ...ports, organization: {} as never }))
      .toThrow(/explicit/);
    const outer = policies[arm].createOuterKernelReader({ ...ports, organization: null, resolveControlAnchor: null });
    expect(await outer(structuralRequest())).toMatchObject({ decision: 'deny', code: 'structural-fixture' });
    expect(ports.organization.loadChain).not.toHaveBeenCalled();
    expect(ports.resolveControlAnchor).not.toHaveBeenCalled();
    expect(ports.structural).toHaveBeenCalledOnce();
  });

  it.each([0, 1])('preserves original structural ownership and explicit authority failures before privilege exemptions (arm %i)', arm => {
    const evaluate = structuralReader(arm);
    const request = structuralRequest();
    request.ctx.isSuperuser = true;
    expect(evaluate(request, { ownership: { required: true, resourceOwnerId: 'other-owner' } }))
      .toMatchObject({ decision: 'deny', code: 'ownership' });
    expect(evaluate(request, { ownership: { required: true, resourceOwnerId: 'original-owner' } }))
      .toMatchObject({ decision: 'allow' });
    expect(evaluate(request, { revoked: true })).toMatchObject({ decision: 'deny', code: 'revoked' });
    expect(evaluate(request, { authorityUnavailable: true,
      authorityUnavailableSources: ['control-anchor-query-failed'] }))
      .toMatchObject({ decision: 'deny', code: 'policy-unavailable',
        serverAudit: { authorityUnavailableSources: ['control-anchor-query-failed'] } });
  });

  it.each([0, 1])('distinguishes applied, prepared and requested revisions with its own generic source (arm %i)', arm => {
    const evaluate = structuralReader(arm);
    const request = structuralRequest();
    const applied = { specificationRevision: '1'.repeat(64), stateRevision: 'opaque-original' };
    const desired = { specificationRevision: '2'.repeat(64), stateRevision: 'opaque-next' };
    expect(evaluate({ ...request, requestedRevision: desired }, { activation: { applied, desired } }))
      .toMatchObject({ decision: 'deny', code: 'stale-activation' });
    expect(evaluate({ ...request, requestedRevision: applied }, { activation: { applied, desired } }))
      .toMatchObject({ decision: 'allow', applied: true, executionRevision: applied, revisionSource: 'applied' });
    expect(evaluate(request, { activation: { prepared: desired } }))
      .toMatchObject({ decision: 'allow', applied: false, executionRevision: desired, revisionSource: 'prepared' });
    expect(evaluate(request)).toEqual({ decision: 'allow', availability: 'unavailable', applied: false });
    expect(readers[arm].sources.some(row => row.path === 'libs/generic/tooldef/src/kernel-enforcement.ts')).toBe(true);
    expect(policies[arm].hostFunctions.map(row => row.name)).toEqual(expect.arrayContaining([
      'operatorKernelDenial', 'evaluateOperatorKernelRequest',
    ]));
  });

  it.each([0, 1])('runs the structural kernel through canonical preflight with an ownership positive and negative control (arm %i)', async arm => {
    const evaluate = structuralReader(arm);
    const handler = vi.fn();
    const input = tool({ fn: handler });
    const ctx = context();
    for (const phaseOwner of ['other-owner', 'original-owner']) {
      const result = await readers[arm].evaluate(input, 'comparison:probe', {}, ctx, {
        kernelEnforcement: request => evaluate(request, { ownership: { required: true, resourceOwnerId: phaseOwner } }),
      });
      expect(result.allowed).toBe(phaseOwner === 'original-owner');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs both canonical role and argument authorization gates without invoking handlers or lifecycle ports', async () => {
    for (const reader of readers) {
      const handler = vi.fn(), recordInvocation = vi.fn(), postInvoke = vi.fn(), onDispatchStart = vi.fn();
      const fixture = tool({ fn: handler, agentRoles: ['worker'],
        authorize: ({ input }) => ({ allow: (input as { limit: number }).limit <= 1, reason: 'argument limit' }) });
      const deps = { recordInvocation, postInvoke, onDispatchStart };
      expect(await reader.evaluate(fixture, 'comparison:probe', { limit: 1 }, context(), deps)).toEqual({ allowed: true });
      expect(await reader.evaluate(fixture, 'comparison:probe', { limit: 2 }, context(), deps))
        .toMatchObject({ allowed: false, error: { code: 'authorization_denied' } });
      expect(await reader.evaluate(fixture, 'comparison:probe', { limit: 1 }, { ...context(), role: 'judge' }, deps))
        .toMatchObject({ allowed: false, error: { code: 'role_not_allowed' } });
      for (const effect of [handler, recordInvocation, postInvoke, onDispatchStart]) expect(effect).not.toHaveBeenCalled();
    }
  });

  it('retains the original run quota and refuses prerequisites without corrective calls', async () => {
    for (const reader of readers) {
      const readQuotaState = vi.fn(async () => ({ count: 2 }));
      expect(await reader.evaluate(tool({ rolesQuota: { worker: { perRun: 2 } } }),
        'comparison:probe', {}, context(), { readQuotaState }))
        .toMatchObject({ allowed: false, error: { code: 'quota_exceeded' } });
      expect(readQuotaState).toHaveBeenCalledWith('comparison:probe', expect.objectContaining({ runId: 'original-run' }),
        'run:original-run');
      const firePrecondition = vi.fn();
      expect(await reader.evaluate(tool({ requires: [{ id: 'not-ready',
        when: { 'args.ready': true }, fire: 'comparison:correct' }] }),
      'comparison:probe', { ready: false }, context(), { firePrecondition }))
        .toMatchObject({ allowed: false, error: { code: 'precondition_failed' } });
      // Exercise the SAME predicate's satisfied arm: a blanket prerequisite
      // refusal must not make the no-corrective-call assertion pass vacuously.
      expect(await reader.evaluate(tool({ requires: [{ id: 'not-ready',
        when: { 'args.ready': true }, fire: 'comparison:correct' }] }),
      'comparison:probe', { ready: true }, context(), { firePrecondition }))
        .toEqual({ allowed: true });
      expect(firePrecondition).not.toHaveBeenCalled();
    }
  });

  it('rejects unpinned imports rather than importing the current host graph', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'idop-dispatch-source-'));
    try {
      const file = join(fixtureRoot, 'libs/generic/tooldef/src/dispatch-stack.ts');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "export { missing as preflightDispatchStack } from 'unrecorded-host-policy';");
      writeFileSync(join(fixtureRoot, 'package-lock.json'), JSON.stringify({ packages: {} }));
      await expect(loadIdopP001DispatchPermissionReader({ root: fixtureRoot, revision: 'working-tree' }))
        .rejects.toThrow(/unpinned import/);
      await expect(loadIdopP001DispatchPermissionReader({ root, revision: 'HEAD' }))
        .rejects.toThrow(/exact source revision/);
    } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
  });
});

describe('IDOP D-043 real pinned role-policy adapter', () => {
  const old = loadIdopP001RolePermissionReader({ root, revision: baseline.base.commit, testingFullAccess: 'off' });
  const current = loadIdopP001RolePermissionReader({ root, revision: 'working-tree', testingFullAccess: 'off' });
  const request = (role: string, capability: string, isSuperuser = false) => ({
    toolName: 'comparison:probe', capabilities: [capability], ctx: { role, isSuperuser, isPowerUser: false },
  });

  it('pins the historical policy AND both runtime dependency sources, independently of today', () => {
    expect(old.sources.map(source => source.path)).toEqual([...IDOP_P001_ROLE_POLICY_SOURCES]);
    for (const source of old.sources) {
      expect(source.sha256).toBe(sha256(execFileSync('git', ['-C', root, 'show', `${baseline.base.commit}:${source.path}`])));
    }
    for (const source of current.sources) expect(source.sha256).toBe(sha256(readFileSync(join(root, source.path))));
    expect(() => loadIdopP001RolePermissionReader({ root, revision: 'HEAD', testingFullAccess: 'off' }))
      .toThrow(/exact source revision/);
  });

  it.each([old, current])('executes the real protected floor, role denial and supervised exemption ($revision)', reader => {
    expect(reader.evaluate(request('worker', 'secrets:read'))).toMatchObject({ withinEnvelope: false, applied: true });
    expect(reader.evaluate(request('worker', 'capability:read'))).toMatchObject({ withinEnvelope: true, applied: true });
    expect(reader.evaluate(request('judge', 'capability:bash'))).toMatchObject({ withinEnvelope: false, applied: true });
    expect(reader.evaluate(request('worker', 'secrets:read', true))).toEqual({ withinEnvelope: true, applied: false });
  });

  it('compares both real implementations on identical inputs and detects an unmanifested gate change', async () => {
    const rows = ['capability:read', 'secrets:read', 'capability:bash'].map(capability => ({
      id: `role:judge:${capability}`, input: request('judge', capability),
    }));
    const options = { population: () => rows.map(row => row.id), enumerate: () => rows,
      before: (input: unknown) => ({ ...old.evaluate(input as ReturnType<typeof request>) }),
      after: (input: unknown) => ({ ...current.evaluate(input as ReturnType<typeof request>) }), manifest: [] };
    expect(await runIdopP001PermissionComparison(options)).toMatchObject({ passed: true, unexpected: [] });
    const mutated = await runIdopP001PermissionComparison({ ...options,
      after: input => ({ ...current.evaluate(input as ReturnType<typeof request>), withinEnvelope: true }) });
    expect(mutated).toMatchObject({ passed: false });
    expect(mutated.unexpected).toContain('role:judge:secrets:read');
    await expect(runIdopP001PermissionComparison({ ...options, enumerate: () => rows.slice(1) }))
      .rejects.toThrow(/incompletely enumerated/);
  });

  it('isolates the launch override rather than inheriting the comparison runner environment', () => {
    const defaultReader = loadIdopP001RolePermissionReader({ root, revision: 'working-tree', testingFullAccess: 'default' });
    expect(defaultReader.evaluate(request('kettle', 'capability:bash')).withinEnvelope).toBe(true);
    expect(current.evaluate(request('kettle', 'capability:bash')).withinEnvelope).toBe(false);
    expect(defaultReader.evaluate(request('kettle', 'secrets:read')).withinEnvelope).toBe(false);
  });

  it('refuses a new dependency instead of substituting the current host implementation', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'idop-role-source-'));
    try {
      for (const path of IDOP_P001_ROLE_POLICY_SOURCES) {
        mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true });
        const source = readFileSync(join(root, path), 'utf8');
        writeFileSync(join(fixtureRoot, path), path.endsWith('/policy.ts') ?
          source.replace('@papercusp/agent-mcp/gate-bypass', '@papercusp/agent-mcp/unpinned') : source);
      }
      expect(() => loadIdopP001RolePermissionReader({ root: fixtureRoot, revision: 'working-tree', testingFullAccess: 'off' }))
        .toThrow(/unpinned import/);
    } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
  });

  it.each([old, current])('executes canonical assignment argument restrictions and exact source bytes ($revision)', reader => {
    const confinement = { denyTools: [], denyOutside: ['work_items:get'],
      denyWorkItemsOutside: { id: 'F-own', harness: 'bench-private', checkout: '/private/assignment' },
      imposedBy: 'comparison-host', reason: 'same original assignment' };
    const decide = (args: unknown, toolName = 'work_items:get') => reader.evaluateArguments({ toolName, args, confinement });
    expect(decide({ id: 'F-own', harness: 'bench-private', resume: true })).toEqual({ allowed: true, applied: true });
    for (const args of [{ id: 'F-other', harness: 'bench-private' }, { id: 'F-own', harness: 'other' },
      { ids: ['F-own', 'F-other'], harness: 'bench-private' }, { id: 'F-own' }, undefined]) {
      expect(decide(args)).toMatchObject({ allowed: false, applied: true, matchedGlob: 'outside-exact-work-item' });
    }
    expect(decide({}, 'work_items:complete')).toMatchObject({ allowed: false, matchedGlob: 'outside-exact-ceiling' });
    expect(reader.evaluateArguments({ toolName: 'work_items:get', args: { id: 'F-own', harness: 'bench-private' },
      confinement: { ...confinement, denyTools: ['work_items:*'] } })).toMatchObject({ allowed: false, matchedGlob: 'work_items:*' });
    for (const source of reader.sources) {
      const expected = reader.revision === 'working-tree' ? readFileSync(join(root, source.path)) :
        execFileSync('git', ['-C', root, 'show', `${reader.revision}:${source.path}`]);
      expect(source.sha256).toBe(sha256(expected));
    }
    expect(reader.sources.map(source => source.path)).toContain('packages/operator-core/lib/capability-envelope/session-confinement.ts');
    // These read-only cases need neither the completion schema nor the
    // benchmark validator; lazy imports must not initialize unrelated policy.
    expect(reader.externalDependencies).toEqual([]);
  });

  it('evaluates the current canonical benchmark validator rather than treating a malformed boundary as absent', () => {
    expect(current.evaluateArguments({ toolName: 'coord:whoami',
      confinement: { denyTools: [], imposedBy: 'host', reason: 'fixture', denyBenchmarkReadsOutside: {} as never } }))
      .toMatchObject({ allowed: false, matchedGlob: 'outside-private-benchmark-read' });
    expect(current.externalDependencies).toEqual([expect.objectContaining({ name: 'zod', version: '4.4.3' })]);
  });
});

describe('IDOP D-043 current builtin source population', () => {
  it('reads current roles and identities with complete source digests and an explicit live-wearer boundary', () => {
    const population = readIdopP001CurrentBuiltinPopulation(root);
    expect(population).toMatchObject({ scope: 'builtin-and-local-pot-source', liveWearersIncluded: false });
    expect(population.roles).toContain('infra-reviewer');
    expect(population.roles).toContain('su');
    expect(population.identities.find(identity => identity.id === 'su')?.slots).toEqual([]);
    expect(population.identities.length).toBeGreaterThan(0);
    for (const source of population.sources) expect(source.sha256).toBe(sha256(readFileSync(join(root, source.path))));
  });

  it('discovers added and retired identities and pot/sidecar roles, and refuses malformed or duplicate identities', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'idop-current-builtins-'));
    const put = (path: string, text: string) => {
      mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true });
      writeFileSync(join(fixtureRoot, path), text);
    };
    const base = 'libs/papercusp/packages/harness/blueprints';
    try {
      for (const path of IDOP_P001_ROLE_POLICY_SOURCES) put(path, readFileSync(join(root, path), 'utf8'));
      put(`${base}/base/blueprint.yaml`, 'id: base\n');
      put(`${base}/base/prompts/fixture-role.role.json`,
        JSON.stringify({ id: 'fixture-role', whenUseful: 'Fixture role.', output: { kind: 'features', featureKind: 'fixture' } }));
      put(`${base}/base/prompts/fixture-role.md`, 'Fixture role prompt.');
      put('.papercusp/blueprint.yaml', 'id: fixture\nroles:\n  - id: pot-role\nfleet:\n  workerRoles:\n    - id: fleet-role\n');
      put(`${base}/one/blueprint.yaml`, 'id: fixture-one\nslots: []\n');
      mkdirSync(join(fixtureRoot, base, 'empty-directory'), { recursive: true });
      expect(readIdopP001CurrentBuiltinPopulation(fixtureRoot).roles).toEqual(
        expect.arrayContaining(['fixture-role', 'pot-role', 'fleet-role']));
      const original = readIdopP001CurrentBuiltinPopulation(fixtureRoot);
      expect(original.directoriesWithoutBlueprint).toEqual([`${base}/empty-directory`]);
      expect(original.identities.map(identity => identity.id)).toEqual(['fixture-one']);
      put(`${base}/two/blueprint.yaml`, 'id: fixture-two\nslots:\n  - slot: practice\n');
      expect(readIdopP001CurrentBuiltinPopulation(fixtureRoot).identities.map(identity => identity.id))
        .toEqual(['fixture-one', 'fixture-two']);
      rmSync(join(fixtureRoot, base, 'one'), { recursive: true });
      expect(readIdopP001CurrentBuiltinPopulation(fixtureRoot).identities.map(identity => identity.id)).toEqual(['fixture-two']);
      expect(original.identities.map(identity => identity.id)).toEqual(['fixture-one']);
      put(`${base}/three/blueprint.yaml`, 'id: fixture-two\nslots:\n  - slot: domain\n');
      expect(() => readIdopP001CurrentBuiltinPopulation(fixtureRoot)).toThrow(/Duplicate current identity/);
      put(`${base}/three/blueprint.yaml`, 'id: fixture-three\nslots: malformed\n');
      expect(() => readIdopP001CurrentBuiltinPopulation(fixtureRoot)).toThrow(/Invalid current identity slots/);
      rmSync(join(fixtureRoot, base, 'three'), { recursive: true });
      put(`${base}/base/prompts/fixture-role.role.json`, '{}');
      expect(() => readIdopP001CurrentBuiltinPopulation(fixtureRoot)).toThrow(/Invalid current role manifest/);
    } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
  });
});

describe('IDOP D-043 installed plugin tool source population', () => {
  // Low-entropy, role-named stand-in for a plugin config secret (the in-tree NEVER_EMIT_MARKER
  // convention): never a credential-shaped literal, which the git-sync secrets guard quarantines.
  const NEVER_EMIT_MARKER = 'never-emit-me';
  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), 'idop-installed-plugin-'));
    const tool = { name: 'read', description: 'Read fixture', inputSchema: { type: 'object' },
      capabilities: ['tasks:read'], expose: { mcp: { name: 'fixture:read' } } } satisfies ToolDefinition;
    const manifest = { name: '@fixture/plugin', version: '1.0.0', capabilities: [...tool.capabilities], tools: [tool] };
    const path = join(dir, 'papercusp.json');
    writeFileSync(path, JSON.stringify({ ...manifest, config: { secret: NEVER_EMIT_MARKER } }));
    const loaded: LoadedPlugin = { path: dir, source: 'project', toolDefinitions: [tool],
      plugin: { ...manifest, papercusp: '*', tools: { read: vi.fn() } } };
    const discovery: PluginDiscoveryInventory = {
      roots: [{ pluginsDir: dir, source: 'project' }], unavailable: [],
      candidates: [{ path: dir, source: 'project', status: 'loaded', pluginName: manifest.name, manifest }],
    };
    const result = { loaded: [loaded], discovery, errors: [] as Array<{ error: string; path: string }> };
    const discover = vi.fn(async () => result);
    return { dir, path, manifest, loaded, discovery, result, discover,
      options: { root: dir, harnessSlug: 'fixture-harness' },
      close: () => rmSync(dir, { recursive: true, force: true }) };
  };

  it('binds selected declarations to exact manifest bytes and preserves failed and shadowed candidates without executing handlers', async () => {
    const f = fixture();
    try {
      f.discovery.candidates.push({ path: '/shadowed', source: 'global', status: 'shadowed', pluginName: f.manifest.name },
        { path: '/broken', source: 'harness', status: 'error', error: 'invalid manifest' });
      f.discovery.unavailable.push({ path: '/unreadable', code: 'EACCES' });
      f.result.errors.push({ path: '/broken', error: 'invalid manifest' });
      const inventory = await readIdopP001InstalledPluginToolPopulation(f.options, { discover: f.discover });
      expect(f.discover).toHaveBeenCalledExactlyOnceWith({ projectDir: join(f.dir, 'libs/papercusp'),
        harnessSlugs: ['fixture-harness'], metadataOnly: true });
      expect(f.loaded.plugin.tools?.read).not.toHaveBeenCalled();
      expect(inventory).toMatchObject({ runtimeRegistrationMeasured: false, dynamicToolsMeasured: false,
        plugins: [{ name: f.manifest.name, declarations: [f.manifest.tools[0]] }],
        discovery: { unavailable: [{ path: '/unreadable', code: 'EACCES' }] }, errors: f.result.errors });
      expect(inventory.sources).toEqual([{ path: f.path, sha256: sha256(readFileSync(f.path)) }]);
      expect(JSON.stringify(inventory)).not.toContain(NEVER_EMIT_MARKER);
      expect(inventory.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally { f.close(); }
  });

  it.each(['omission', 'substitution', 'duplicate', 'changed-manifest'])('rejects %s rather than reporting a complete installed population', async defect => {
    const f = fixture();
    try {
      if (defect === 'omission') f.result.loaded = [];
      if (defect === 'substitution') f.loaded.toolDefinitions = [];
      if (defect === 'duplicate') f.discovery.candidates.push({ ...f.discovery.candidates[0] });
      if (defect === 'changed-manifest') writeFileSync(f.path, JSON.stringify({ ...f.manifest, tools: [] }));
      await expect(readIdopP001InstalledPluginToolPopulation(f.options, { discover: f.discover })).rejects.toThrow(/IDOP installed plugin/);
    } finally { f.close(); }
  });

  it('accepts a measured empty installation set while retaining discovery failures', async () => {
    const f = fixture();
    try {
      f.result.loaded = [];
      f.discovery.candidates = [];
      f.discovery.unavailable.push({ path: '/missing-global-root', code: 'ENOENT' });
      const inventory = await readIdopP001InstalledPluginToolPopulation(f.options, { discover: f.discover });
      expect(inventory.plugins).toEqual([]);
      expect(inventory.discovery.unavailable).toEqual(f.discovery.unavailable);
      expect(inventory.dynamicToolsMeasured).toBe(false);
    } finally { f.close(); }
  });

  it('uses the real metadata loader without importing an installed entry or exporting its configuration', async () => {
    const f = fixture();
    try {
      const pluginDir = join(f.dir, 'libs/papercusp/plugins/fixture');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, 'papercusp.json'), readFileSync(f.path));
      writeFileSync(join(pluginDir, 'index.cjs'), "throw new Error('installed entry must not execute');");
      const { loadPlugins } = await import('@papercusp/plugin-loader');
      const inventory = await readIdopP001InstalledPluginToolPopulation(f.options, {
        discover: options => loadPlugins({ ...options, harnessSlugs: [], globalPluginsDir: join(f.dir, 'empty-global') }),
      });
      expect(inventory.errors).toEqual([]);
      expect(inventory.plugins).toHaveLength(1);
      expect(inventory.plugins[0]).toMatchObject({ name: f.manifest.name, declarations: [f.manifest.tools[0]] });
      expect(JSON.stringify(inventory)).not.toContain(NEVER_EMIT_MARKER);
    } finally { f.close(); }
  });
});

describe('IDOP D-043 selected runtime library population', () => {
  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), 'idop-library-'));
    // The first complete page has no identities. Stopping on an empty identity
    // array would lose the installed identity on the second page.
    const sources = Array.from({ length: 100 }, (_, index) => ({
      id: `source-${String(index).padStart(3, '0')}`, tier: 'builtin' as const,
      file: join(dir, `source-${index}.yaml`),
    }));
    for (const source of sources) writeFileSync(source.file, `id: ${source.id}\n`);
    const installed = { id: 'zz-installed', tier: 'installed' as const, file: join(dir, 'installed.yaml') };
    writeFileSync(installed.file, 'id: installed-source\nslots: []\n');
    const catalog = [...sources, installed];
    const identity = { id: installed.id, sourceId: 'installed-source', tier: installed.tier,
      version: '1.0.0', sourceRevision: 'a'.repeat(64), sourcePath: installed.file,
      description: 'Fixture', slots: [], launchCompatibility: { eligible: false, reason: 'Needs launch selection.' } };
    const pluginRole = { id: 'fixture:checker', whenUseful: 'Fixture',
      output: { kind: 'features' as const, featureKind: 'fixture' },
      source: { kind: 'plugin' as const, plugin: 'fixture', promptPath: join(dir, 'role.md'), dir } };
    const deps = {
      sources: () => catalog,
      roles: (_harness: string) => [pluginRole],
      page: async (opts: { after?: string } = {}) => ({ ok: true,
        identities: opts.after ? [structuredClone(identity)] : [], unreadable: [],
        count: opts.after ? 1 : 0, scanned: opts.after ? 1 : 100,
        nextAfter: opts.after ? null : sources.at(-1)!.id }),
    };
    return { dir, sources, installed, identity, pluginRole, deps,
      options: { root: dir, harnessSlug: 'fixture-harness' },
      close: () => rmSync(dir, { recursive: true, force: true }) };
  };

  it('traverses empty identity pages and includes installed sources and harness-enabled plugin roles', async () => {
    const f = fixture();
    try {
      const harnesses: string[] = [];
      const result = await readIdopP001CurrentLibraryPopulation(f.options, { ...f.deps,
        roles: harness => { harnesses.push(harness); return [f.pluginRole]; } });
      expect(result).toMatchObject({ scope: 'selected-library-and-enabled-plugin-role-source',
        liveWearersIncluded: false, identities: [f.identity], roles: [f.pluginRole] });
      expect(result.pages).toEqual([
        { after: null, scanned: 100, ids: [], unreadableIds: [], nextAfter: 'source-099' },
        { after: 'source-099', scanned: 1, ids: ['zz-installed'], unreadableIds: [], nextAfter: null },
      ]);
      expect(harnesses).toEqual(['fixture-harness', 'fixture-harness']);
      expect(result.sources).toHaveLength(101);
      for (const source of result.sources) expect(source.sha256).toBe(sha256(readFileSync(source.file)));
    } finally { f.close(); }
  });

  it.each(['omitted', 'substituted', 'wrong-tier', 'wrong-source', 'wrong-slots'])(
    'refuses a library identity that is %s despite correct source scan counts', async defect => {
      const f = fixture();
      try {
        await expect(readIdopP001CurrentLibraryPopulation(f.options, { ...f.deps, page: async opts => {
          const page = await f.deps.page(opts);
          if (opts?.after) {
            if (defect === 'omitted') { page.identities = []; page.count = 0; }
            if (defect === 'substituted') page.identities[0].id = 'other';
            if (defect === 'wrong-tier') Object.assign(page.identities[0], { tier: 'builtin' });
            if (defect === 'wrong-source') page.identities[0].sourceId = 'other';
            if (defect === 'wrong-slots') Object.assign(page.identities[0], { slots: [{ slot: 'domain', cardinality: null }] });
          }
          return page;
        } })).rejects.toThrow(/omitted or substituted/);
      } finally { f.close(); }
    });

  it('includes an attestation refusal as an explicit negative source input', async () => {
    const f = fixture();
    const refusal = { id: f.installed.id, tier: f.installed.tier, sourcePath: f.installed.file,
      error: 'attestation-missing: installed identity has no publisher attestation' };
    try {
      const result = await readIdopP001CurrentLibraryPopulation(f.options, { ...f.deps,
        page: async opts => {
          const page = await f.deps.page(opts);
          return opts?.after ? { ...page, identities: [], count: 0, unreadable: [refusal] } : page;
        } });
      expect(result.identities).toEqual([]);
      expect(result.unreadable).toEqual([refusal]);
      expect(result.pages.at(-1)).toMatchObject({ ids: [], unreadableIds: [f.installed.id] });
      expect(result.sources.find(source => source.id === refusal.id)?.sha256)
        .toBe(sha256(readFileSync(f.installed.file)));
    } finally { f.close(); }
  });

  it.each(['duplicate', 'overlap', 'substituted', 'wrong-tier', 'wrong-path', 'blank-error', 'nonidentity'])(
    'refuses an invalid identity refusal partition: %s', async defect => {
      const f = fixture();
      try {
        await expect(readIdopP001CurrentLibraryPopulation(f.options, { ...f.deps, page: async opts => {
          const page = await f.deps.page(opts);
          if (!opts?.after) return page;
          const refusal = { id: f.installed.id, tier: f.installed.tier as 'installed' | 'builtin' | 'local',
            sourcePath: f.installed.file, error: 'attestation-missing' };
          if (defect === 'substituted') refusal.id = 'other';
          if (defect === 'wrong-tier') refusal.tier = 'builtin';
          if (defect === 'wrong-path') refusal.sourcePath = '/different/source.yaml';
          if (defect === 'blank-error') refusal.error = '   ';
          if (defect === 'nonidentity') Object.assign(refusal,
            { id: f.sources[0].id, tier: f.sources[0].tier, sourcePath: f.sources[0].file });
          return { ...page, identities: defect === 'overlap' ? page.identities : [],
            count: defect === 'overlap' ? 1 : 0,
            unreadable: defect === 'duplicate' ? [refusal, refusal] : [refusal] };
        } })).rejects.toThrow(/incomplete or unreadable page|omitted or substituted/);
      } finally { f.close(); }
    });

  it.each(['early-end', 'wrong-cursor', 'wrong-scan', 'wrong-count', 'unreadable'])(
    'refuses incomplete paging: %s', async defect => {
      const f = fixture();
      try {
        await expect(readIdopP001CurrentLibraryPopulation(f.options, { ...f.deps, page: async opts => {
          const page = await f.deps.page(opts);
          if (defect === 'early-end') page.nextAfter = null;
          if (defect === 'wrong-cursor') page.nextAfter = 'somewhere-else';
          if (defect === 'wrong-scan') page.scanned = 0;
          if (defect === 'wrong-count') page.count = 17;
          if (defect === 'unreadable') Object.assign(page, { unreadable: [{ id: 'broken', error: 'Fixture' }] });
          return page;
        } })).rejects.toThrow(/incomplete or unreadable page/);
      } finally { f.close(); }
    });

  it.each(['bytes', 'inventory', 'roles'])('refuses a %s change during the read', async defect => {
    const f = fixture();
    try {
      let roleReads = 0;
      await expect(readIdopP001CurrentLibraryPopulation(f.options, { ...f.deps,
        roles: () => [{ ...f.pluginRole, whenUseful: defect === 'roles' ? String(roleReads++) : 'Fixture' }],
        page: async opts => {
          const page = await f.deps.page(opts);
          if (opts?.after && defect === 'bytes') writeFileSync(f.installed.file, 'id: installed-source\nslots: []\ndescription: Changed\n');
          if (opts?.after && defect === 'inventory') f.deps.sources().pop();
          return page;
        } })).rejects.toThrow(/changed during enumeration/);
    } finally { f.close(); }
  });

  it('refuses duplicate source and role ids and an implicit harness scope', async () => {
    const f = fixture();
    try {
      await expect(readIdopP001CurrentLibraryPopulation({ ...f.options, harnessSlug: '' }, f.deps))
        .rejects.toThrow(/explicit harness/);
      await expect(readIdopP001CurrentLibraryPopulation(f.options, { ...f.deps,
        sources: () => [f.installed, f.installed] })).rejects.toThrow(/duplicate source/);
      await expect(readIdopP001CurrentLibraryPopulation(f.options, { ...f.deps,
        roles: () => [f.pluginRole, f.pluginRole] })).rejects.toThrow(/duplicate runtime roles/);
    } finally { f.close(); }
  });
});

describe('IDOP D-043 applied stack source population', () => {
  const artifact = (id: string) => compileAgentSpecification({
    source: { id, workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } },
    prompt: { text: `Prompt for ${id}.` },
  });
  const applied = artifact('applied-agent');
  const desired = artifact('desired-agent');
  const revision = { specificationRevision: applied.specificationRevision, stateRevision: '1'.repeat(64) };
  const ownerId = 'fixture-applied-owner';
  const anchor = { ownerId, applied: revision };
  const receipt = { ...revision, stack: ['domain:applied-agent'], specificationArtifact: applied };
  const record = { role: 'judge', specificationRevision: desired.specificationRevision,
    stateRevision: '2'.repeat(64), specificationArtifact: desired, stack: ['domain:desired-agent'],
    identityHistory: [receipt] };
  const deps = () => ({ anchors: async () => [structuredClone(anchor)], record: async () => structuredClone(record) });

  it('reads exact applied history through the execution resolver, preserving role, stack and layer pins', async () => {
    const reads: unknown[] = [];
    const result = await readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(),
      record: async (...args) => { reads.push(args); return record; } });
    expect(reads).toEqual([[ownerId, 'fixture-workspace', revision]]);
    expect(result).toMatchObject({ scope: 'workspace-persisted-applied-anchors',
      includesInactiveAnchors: true, livenessMeasured: false,
      stacks: [{ ownerId, applied: revision, role: 'judge', explicitStack: ['domain:applied-agent'],
        artifact: applied, artifactSha256: sha256(JSON.stringify(applied)) }] });
    expect(result.stacks[0].layers).toContainEqual(expect.objectContaining({ ref: 'applied-agent' }));
    expect(result.stacks[0].artifact!.specificationRevision).not.toBe(desired.specificationRevision);
  });

  it('admits the execution resolver control-only transition and the recorded SU role default', async () => {
    const result = await readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(),
      record: async () => ({ ...receipt, stateRevision: '3'.repeat(64) }) });
    expect(result.stacks[0]).toMatchObject({ role: 'su', applied: revision,
      explicitStack: ['domain:applied-agent'], artifact: applied });
  });

  it.each([
    { label: 'missing launch', raw: null, reason: 'receipt-missing' },
    { label: 'missing applied receipt', raw: { ...record, identityHistory: [] }, reason: 'receipt-missing' },
    { label: 'tampered applied artifact', raw: { ...record, identityHistory: [{ ...receipt,
      specificationArtifact: { ...applied, compilerVersion: 'tampered' } }] }, reason: 'replay-failed' },
  ])('preserves a canonical applied-artifact refusal without using desired state ($label)', async ({ raw, reason }) => {
    const result = await readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(), record: async () => raw });
    expect(result.stacks).toEqual([]);
    expect(result.refused).toEqual([{ ...anchor, resolution: { kind: 'stale-artifact', reason },
      launchRecord: raw, recordSha256: sha256(JSON.stringify(raw)) }]);
  });

  it('propagates a failed launch-record read instead of manufacturing a receipt refusal', async () => {
    await expect(readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(),
      record: async () => { throw new Error('authority read failed'); } })).rejects.toThrow('authority read failed');
  });

  it('releases payloads only after resolving and fingerprinting the complete applied inputs', async () => {
    const inputs = { anchors: async () => [anchor, { ownerId: 'refused-owner', applied: revision }],
      record: async (owner: string) => owner === ownerId ? structuredClone(record) : null };
    const full = await readIdopP001AppliedStackPopulation('fixture-workspace', inputs);
    const compact = await readIdopP001AppliedStackPopulation('fixture-workspace', inputs, { payloads: 'digests-only' });
    expect(full.payloads).toBe('retained');
    expect(compact).toEqual({ ...full, payloads: 'digests-only',
      stacks: full.stacks.map(({ launchRecord: _record, artifact: _artifact, ...member }) => member),
      refused: full.refused.map(({ launchRecord: _record, ...member }) => member) });
    expect(compact.stacks[0]).not.toHaveProperty('artifact');
    expect(compact.stacks[0]).not.toHaveProperty('launchRecord');
    expect(compact.refused[0]).not.toHaveProperty('launchRecord');
    expect(compact.stacks[0]).toMatchObject({ explicitStack: ['domain:applied-agent'],
      recordSha256: sha256(JSON.stringify(record)), artifactSha256: sha256(JSON.stringify(applied)) });
    expect(compact.refused[0]).toMatchObject({ resolution: { kind: 'stale-artifact', reason: 'receipt-missing' },
      recordSha256: sha256('null') });
    const changed = await readIdopP001AppliedStackPopulation('fixture-workspace', { ...inputs,
      record: async (owner: string) => owner === ownerId ? { ...record, unrelatedOriginalInput: 'changed' } : null,
    }, { payloads: 'digests-only' });
    expect(changed.stacks[0].recordSha256).not.toBe(compact.stacks[0].recordSha256);
    expect(changed.stacks[0].artifactSha256).toBe(compact.stacks[0].artifactSha256);
  });

  it('propagates receipt-read failures and refuses malformed retention in digest-only mode', async () => {
    await expect(readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(),
      record: async () => { throw new Error('original input unavailable'); } }, { payloads: 'digests-only' }))
      .rejects.toThrow('original input unavailable');
    await expect(readIdopP001AppliedStackPopulation('fixture-workspace', deps(),
      { payloads: 'invalid' as 'digests-only' })).rejects.toThrow(/payload retention/);
  });

  it.each(['37b21f82cba4d206174fa104', 'native-state-v1'])(
    'preserves an opaque nonempty applied state revision: %s', async stateRevision => {
      const pair = { ...revision, stateRevision };
      const reads: unknown[] = [];
      const result = await readIdopP001AppliedStackPopulation('fixture-workspace', {
        anchors: async () => [{ ownerId, applied: pair }],
        record: async (...args) => {
          reads.push(args);
          return { ...record, identityHistory: [{ ...receipt, stateRevision }] };
        },
      });
      expect(reads).toEqual([[ownerId, 'fixture-workspace', pair]]);
      expect(result.stacks[0]).toMatchObject({ applied: pair, artifact: applied });
    });

  it.each(['', '   ', null, 123])('refuses an invalid applied state revision: %s', async stateRevision => {
    await expect(readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(),
      anchors: async () => [{ ownerId, applied: { ...revision, stateRevision } }] }))
      .rejects.toThrow(/malformed applied anchor/);
  });

  it('refuses a removed wearer or changed applied revision during enumeration', async () => {
    for (const changed of [[], [{ ...anchor, applied: { ...revision, stateRevision: '4'.repeat(64) } }]]) {
      let reads = 0;
      await expect(readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(),
        anchors: async () => reads++ ? changed : [anchor] })).rejects.toThrow(/changed during enumeration/);
    }
  });

  it('refuses duplicate owners, malformed revisions or stacks and an implicit workspace', async () => {
    await expect(readIdopP001AppliedStackPopulation('', deps())).rejects.toThrow(/require a workspace/);
    await expect(readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(),
      anchors: async () => [anchor, anchor] })).rejects.toThrow(/duplicate applied owner/);
    await expect(readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(),
      anchors: async () => [{ ownerId, applied: {} }] })).rejects.toThrow(/malformed applied anchor/);
    await expect(readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(),
      record: async () => ({ ...receipt, stack: [''] }) })).rejects.toThrow(/malformed applied stack/);
  });

  it('represents an empty applied population without claiming runtime liveness', async () => {
    expect(await readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(), anchors: async () => [] }))
      .toMatchObject({ stacks: [], includesInactiveAnchors: true, livenessMeasured: false });
  });

  const comparisonInputs = async () => {
    const population = await readIdopP001AppliedStackPopulation('fixture-workspace', {
      anchors: async () => [anchor, { ownerId: 'refused-owner', applied: revision }],
      record: async owner => owner === ownerId ? record : null,
    });
    const source = { id: 'applied-agent', tier: 'installed' as const, file: '/selected/identity.yaml',
      kind: 'identity' as const, sourceId: 'applied-agent', slots: [], sha256: 'a'.repeat(64) };
    return {
      builtin: { scope: 'builtin-and-local-pot-source' as const, liveWearersIncluded: false as const,
        roles: ['judge', 'builtin-only'], identities: [{ id: 'applied-agent', path: 'builtin.yaml', slots: [] }],
        sources: [{ path: 'builtin.yaml', sha256: 'b'.repeat(64) }], directoriesWithoutBlueprint: [] },
      library: { scope: 'selected-library-and-enabled-plugin-role-source' as const, liveWearersIncluded: false as const,
        harnessSlug: 'fixture-harness', roles: [{ id: 'plugin:checker', whenUseful: 'Check fixture',
          output: { kind: 'spec' as const },
          source: { kind: 'plugin' as const, plugin: 'plugin', promptPath: '/plugin/checker.md', dir: '/plugin' } }],
        sources: [source], identities: [], pages: [],
        unreadable: [{ id: source.id, tier: source.tier, sourcePath: source.file, error: 'attestation-missing' }] },
      applied: population,
    } satisfies Parameters<typeof joinIdopP001ComparisonPopulation>[0];
  };

  it('joins independent source populations without hiding shadowed refusals or inactive applied anchors', async () => {
    const input = await comparisonInputs();
    const inventory = joinIdopP001ComparisonPopulation(input);
    expect(inventory.population).toEqual(['identity:applied-agent', 'role:builtin-only', 'role:judge',
      'role:plugin:checker', 'stack:fixture-applied-owner', 'stack:refused-owner']);
    expect(inventory).toMatchObject({ livenessMeasured: false, includesInactiveAnchors: true,
      workspaceId: 'fixture-workspace', harnessSlug: 'fixture-harness' });
    expect(inventory.members[0].sources.map(({ origin, status }) => ({ origin, status }))).toEqual([
      { origin: 'builtin', status: 'declared' }, { origin: 'library', status: 'refused' },
    ]);
    expect(inventory.members.at(-1)!.sources[0].status).toBe('refused');
    expect(JSON.stringify(inventory)).toContain('receipt-missing');
    expect(JSON.stringify(inventory)).not.toContain('desired-agent');
    const again = joinIdopP001ComparisonPopulation(structuredClone(input));
    expect(again.sha256).toBe(inventory.sha256);
    input.builtin.roles.push('later-role');
    expect(inventory.population).not.toContain('role:later-role');
  });

  it('produces the identical joined domain from retained and digest-only applied populations', async () => {
    const input = await comparisonInputs();
    const compact = await readIdopP001AppliedStackPopulation('fixture-workspace', {
      anchors: async () => [anchor, { ownerId: 'refused-owner', applied: revision }],
      record: async owner => owner === ownerId ? record : null,
    }, { payloads: 'digests-only' });
    expect(joinIdopP001ComparisonPopulation({ ...input, applied: compact }))
      .toEqual(joinIdopP001ComparisonPopulation(input));
  });

  it.each(['duplicate-role', 'duplicate-owner', 'missing-source', 'omitted-library-refusal', 'wrong-source'])(
    'rejects a malformed joined comparison domain: %s', async defect => {
      const input = await comparisonInputs();
      if (defect === 'duplicate-role') input.builtin.roles.push('judge');
      if (defect === 'duplicate-owner') input.applied.refused.push({ ...input.applied.refused[0], ownerId });
      if (defect === 'missing-source') input.builtin.sources = [];
      if (defect === 'omitted-library-refusal') input.library.unreadable = [];
      if (defect === 'wrong-source') input.library.unreadable[0].sourcePath = '/substituted.yaml';
      expect(() => joinIdopP001ComparisonPopulation(input)).toThrow(/IDOP comparison/);
    });

  it('drives the existing omission and unauthorized-difference detectors from the independent joined domain', async () => {
    const inventory = joinIdopP001ComparisonPopulation(await comparisonInputs());
    const cases = inventory.population.map(id => ({ id, input: { request: id } }));
    const options = { population: () => inventory.population, enumerate: () => cases,
      before: () => ({ allowed: false }), after: () => ({ allowed: false }), manifest: [] };
    expect(await runIdopP001PermissionComparison(options)).toMatchObject({ passed: true });
    await expect(runIdopP001PermissionComparison({ ...options, enumerate: () => cases.slice(1) }))
      .rejects.toThrow(/incompletely enumerated/);
    expect(await runIdopP001PermissionComparison({ ...options, after: (_input, id) => ({ allowed: id.startsWith('stack:') }) }))
      .toMatchObject({ passed: false, unexpected: ['stack:fixture-applied-owner', 'stack:refused-owner'] });
    // This is detector calibration only; these fixture outcomes are not a
    // permission comparison of the source/anchor population itself.
  });
});

describe('IDOP D-043 streamed applied archive finalization', () => {
  const manifest = { kind: 'manifest', scope: 'workspace-persisted-applied-anchors', workspaceId: 'archive-fixture',
    includesInactiveAnchors: true, livenessMeasured: false, source: 'pinned-source.ts', sourceSha256: '1'.repeat(64),
    startedAt: '2026-11-16T08:00:00Z', completedAt: '2026-11-16T08:01:00Z' };
  const applied = { specificationRevision: '2'.repeat(64), stateRevision: 'opaque-applied' };
  const rows = () => [manifest,
    { kind: 'stack', ownerId: 'su-one', applied, recordSha256: '3'.repeat(64), artifactSha256: '4'.repeat(64) },
    { kind: 'refused', ownerId: 'su-two', applied, recordSha256: '5'.repeat(64),
      resolution: { kind: 'stale-artifact', reason: 'receipt-missing' } }];
  const fixture = async (records: unknown[], run: (path: string, bytes: Buffer) => Promise<void>, corrupt = false) => {
    const directory = mkdtempSync(join(tmpdir(), 'idop-applied-archive-'));
    const path = join(directory, 'snapshot.jsonl.gz');
    const bytes = gzipSync(records.map(row => JSON.stringify(row) + '\n').join(''));
    try {
      writeFileSync(path, corrupt ? bytes.subarray(0, bytes.length - 5) : bytes);
      await run(path, bytes);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  };
  const options = (path: string) => ({ path, workspaceId: 'archive-fixture', sourceSha256: '1'.repeat(64), expectedTotal: 2 });

  it('verifies full gzip/JSON EOF and the disjoint readable/refused population without materializing private payloads', async () => {
    const records = rows();
    Object.assign(records[1], { launchRecord: { privatePayload: 'large 🦊 payload '.repeat(150_000),
      ownerId: 'nested-must-not-count', kind: 'refused' } });
    await fixture(records, async (path, bytes) => {
      const result = await inspectIdopP001AppliedStackArchive(options(path));
      expect(result).toMatchObject({ manifest, total: 2, stacks: 1, refused: 1,
        refusalReasons: { 'receipt-missing': 1 }, outputSha256: sha256(bytes), compressedBytes: bytes.length });
      expect(result.rows.map(row => row.ownerId)).toEqual(['su-one', 'su-two']);
      expect(JSON.stringify(result)).not.toContain('privatePayload');
    });
  });
  it('rejects a truncated gzip rather than publishing a partial successful summary', async () => {
    await fixture(rows(), async path => {
      await expect(inspectIdopP001AppliedStackArchive(options(path))).rejects.toThrow();
    }, true);
  });
  it('rejects an independently expected but omitted population row', async () => {
    await fixture(rows().slice(0, 2), async path => {
      await expect(inspectIdopP001AppliedStackArchive(options(path))).rejects.toThrow(/omitted expected/);
    });
  });
  it('rejects duplicate owners across readable and refused partitions', async () => {
    const records = rows();
    Object.assign(records[2], { ownerId: 'su-one' });
    await fixture(records, async path => {
      await expect(inspectIdopP001AppliedStackArchive(options(path))).rejects.toThrow(/duplicated/);
    });
  });
  it('requires the exact source/workspace manifest and expected compressed digest', async () => {
    await fixture(rows(), async path => {
      await expect(inspectIdopP001AppliedStackArchive({ ...options(path), sourceSha256: '6'.repeat(64) }))
        .rejects.toThrow(/manifest mismatch/);
      await expect(inspectIdopP001AppliedStackArchive({ ...options(path), expectedOutputSha256: '7'.repeat(64) }))
        .rejects.toThrow(/digest mismatch/);
    });
  });
  it('rejects unknown or metadata-free root records instead of losing them through selection', async () => {
    await fixture([...rows(), { unknown: 'omitted object' }], async path => {
      await expect(inspectIdopP001AppliedStackArchive(options(path))).rejects.toThrow(/incomplete/);
    });
    const records = rows();
    Object.assign(records[1], { kind: 'other' });
    await fixture(records, async path => {
      await expect(inspectIdopP001AppliedStackArchive(options(path))).rejects.toThrow(/population row/);
    });
  });
});

describe('IDOP D-043 repository expected-difference manifest', () => {
  const options = { root, baselineRevision: baseline.base.commit, scope: 'source-role-envelope' };
  const fixture = (edit: (manifest: Record<string, unknown>) => void, check: (fixtureRoot: string) => void) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'idop-differences-'));
    try {
      const manifest = JSON.parse(readFileSync(join(root, IDOP_P001_DIFFERENCES_REL), 'utf8'));
      edit(manifest);
      const path = join(fixtureRoot, IDOP_P001_DIFFERENCES_REL);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(manifest));
      check(fixtureRoot);
    } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
  };

  it('reads the preservation requirement independently of either evaluator and binds its exact bytes', () => {
    const manifest = readIdopP001ExpectedPermissionDifferences(options);
    expect(manifest).toMatchObject({ id: 'source-role-envelope', baselineRevision: baseline.base.commit,
      differences: [], authorityRefs: ['identity-definitions-own-policy-2026-10-17#R-2',
        'identity-definitions-own-policy-2026-10-17#D-043'] });
    expect(manifest.sha256).toBe(sha256(readFileSync(join(root, IDOP_P001_DIFFERENCES_REL))));
    expect(() => readIdopP001ExpectedPermissionDifferences({ ...options, baselineRevision: 'f'.repeat(40) }))
      .toThrow(/substituted baseline/);
    expect(() => readIdopP001ExpectedPermissionDifferences({ ...options, scope: 'runtime-dispatch' }))
      .toThrow(/does not cover/);
  });

  it.each(['foreign-authority', 'unknown-field', 'duplicate-scope', 'duplicate-allowance'])(
    'refuses %s instead of broadening the repository allowance', kind => {
      fixture(manifest => {
        const scope = { id: 'source-role-envelope', expectation: 'preserve',
          authorityRefs: ['identity-definitions-own-policy-2026-10-17#R-2'], differences: [] as IdopPermissionDifference[] };
        const difference: IdopPermissionDifference = { id: 'role:fixture', inputSha256: 'a'.repeat(64),
          beforeSha256: 'b'.repeat(64), afterSha256: 'c'.repeat(64), authorityRefs: [...scope.authorityRefs] };
        if (kind === 'foreign-authority') scope.authorityRefs = ['another-plan#R-2'];
        if (kind === 'unknown-field') manifest.acceptAllDifferences = true;
        if (kind === 'duplicate-allowance') scope.differences = [difference, difference];
        manifest.scopes = kind === 'duplicate-scope' ? [scope, scope] : [scope];
      }, fixtureRoot => expect(() => readIdopP001ExpectedPermissionDifferences({ ...options, root: fixtureRoot }))
        .toThrow());
    });

  it('uses the repository allowance with both real source arms and retains omission and unauthorized-change detectors', async () => {
    const manifest = readIdopP001ExpectedPermissionDifferences(options);
    const old = loadIdopP001RolePermissionReader({ root, revision: manifest.baselineRevision, testingFullAccess: 'off' });
    const current = loadIdopP001RolePermissionReader({ root, revision: 'working-tree', testingFullAccess: 'off' });
    const cases = ['capability:read', 'secrets:read', 'capability:bash'].map(capability => ({
      id: `role:judge:${capability}`, input: { toolName: 'comparison:probe', capabilities: [capability],
        ctx: { role: 'judge', isSuperuser: false, isPowerUser: false } },
    }));
    type Request = Parameters<typeof old.evaluate>[0];
    const run = { population: () => cases.map(row => row.id), enumerate: () => cases,
      before: (input: unknown) => ({ ...old.evaluate(input as Request) }),
      after: (input: unknown) => ({ ...current.evaluate(input as Request) }), manifest: manifest.differences };
    expect(await runIdopP001PermissionComparison(run)).toMatchObject({ passed: true, differences: [] });
    await expect(runIdopP001PermissionComparison({ ...run, enumerate: () => cases.slice(1) }))
      .rejects.toThrow(/incompletely enumerated/);
    expect(await runIdopP001PermissionComparison({ ...run,
      after: (input: unknown) => ({ ...current.evaluate(input as Request), withinEnvelope: true }) }))
      .toMatchObject({ passed: false, unexpected: expect.arrayContaining(['role:judge:secrets:read']) });
  });
});

describe('IDOP P-001 current-population comparison controls (D-043)', () => {
  const id = 'role:fixture';
  const input = { limit: 1 };
  const before = { tools: { read: { limit: 1 } } };
  const after = { tools: { read: { limit: 2 } } };
  const allowance = (): IdopPermissionDifference => ({ id,
    inputSha256: sha256(JSON.stringify(input)), beforeSha256: sha256(JSON.stringify(before)),
    afterSha256: sha256(JSON.stringify(after)), authorityRefs: ['identity-definitions-own-policy-2026-10-17#R-2'] });
  const options = () => ({ population: () => [id], enumerate: () => [{ id, input }],
    before: () => before, after: () => before, manifest: [] as IdopPermissionDifference[] });

  it('runs both readers on independent copies of the same enumerated input', async () => {
    const seen: unknown[] = [];
    const result = await runIdopP001PermissionComparison({ ...options(), before: value => {
      seen.push(structuredClone(value)); (value as { limit: number }).limit = 99; return before;
    }, after: value => { seen.push(value); return before; } });
    expect(result).toMatchObject({ passed: true, population: [id], unexpected: [], unusedManifest: [] });
    expect(result.checked.map(row => row.id)).toEqual([id]);
    expect(seen).toEqual([input, input]);
    expect(input).toEqual({ limit: 1 });
  });
  it('rejects an omitted or substituted case even when counts match', async () => {
    await expect(runIdopP001PermissionComparison({ ...options(), enumerate: () => [] })).rejects.toThrow(/incompletely enumerated/);
    await expect(runIdopP001PermissionComparison({ ...options(), enumerate: () => [{ id: 'role:other', input }] }))
      .rejects.toThrow(/incompletely enumerated/);
    await expect(runIdopP001PermissionComparison({ ...options(), population: () => [id, id] }))
      .rejects.toThrow(/duplicated/);
  });
  it('detects an argument-scope change even when the tool names are unchanged', async () => {
    expect(await runIdopP001PermissionComparison({ ...options(), after: () => after }))
      .toMatchObject({ passed: false, unexpected: [id] });
    expect(await runIdopP001PermissionComparison({ ...options(), after: () => ({ tools: {} }) }))
      .toMatchObject({ passed: false, unexpected: [id] });
  });
  it('accepts only the exact independently specified difference and its input', async () => {
    expect(await runIdopP001PermissionComparison({ ...options(), after: () => after, manifest: [allowance()] }))
      .toMatchObject({ passed: true, unexpected: [], differences: [allowance()] });
    expect(await runIdopP001PermissionComparison({ ...options(), after: () => ({ tools: { read: { limit: 3 } } }),
      manifest: [allowance()] })).toMatchObject({ passed: false, unexpected: [id] });
    expect(await runIdopP001PermissionComparison({ ...options(), enumerate: () => [{ id, input: { limit: 2 } }],
      after: () => after, manifest: [allowance()] })).toMatchObject({ passed: false, unexpected: [id] });
  });
  it('rejects stale, duplicate and unattributed allowances', async () => {
    expect(await runIdopP001PermissionComparison({ ...options(), manifest: [allowance()] }))
      .toMatchObject({ passed: false, unusedManifest: [id] });
    await expect(runIdopP001PermissionComparison({ ...options(), manifest: [allowance(), allowance()] }))
      .rejects.toThrow(/unique current cases/);
    await expect(runIdopP001PermissionComparison({ ...options(), manifest: [{ ...allowance(), authorityRefs: [] }] }))
      .rejects.toThrow(/requirement\/decision/);
  });
  it('normalizes JSON object order while preserving array and vault-setting differences', async () => {
    expect(await runIdopP001PermissionComparison({ ...options(), before: () => ({ a: 1, b: 2 }),
      after: () => ({ b: 2, a: 1 }) })).toMatchObject({ passed: true });
    expect(await runIdopP001PermissionComparison({ ...options(), before: () => ({ vault: { recall: ['a', 'b'] } }),
      after: () => ({ vault: { recall: ['b', 'a'] } }) })).toMatchObject({ passed: false, unexpected: [id] });
    await expect(runIdopP001PermissionComparison({ ...options(), after: () => ({ limit: Number.NaN }) }))
      .rejects.toThrow(/complete JSON/);
    const sparse = Array<null>(1);
    await expect(runIdopP001PermissionComparison({ ...options(), before: () => sparse, after: () => sparse }))
      .rejects.toThrow(/complete JSON/);
  });
});

describe('IDOP P-001 frozen baseline', () => {
  it('pins the exact pre-implementation su render to a reachable commit and blob', () => {
    const historical = execFileSync('git', ['-C', root, 'show', `${baseline.base.commit}:${baseline.base.promptPath}`]);
    expect(baseline.base.promptPath).toBe(IDOP_P001_PROMPT_REL);
    expect(execFileSync('git', ['-C', root, 'rev-parse', `${baseline.base.commit}:${baseline.base.promptPath}`], { encoding: 'utf8' }).trim()).toBe(baseline.base.promptGitBlob);
    expect(historical).toHaveLength(baseline.base.promptBytes);
    expect(sha256(historical)).toBe(baseline.base.promptSha256);
    expect(SU_RENDER_PARITY_BASELINE).toContain(IDOP_P001_BASELINE_REL);
  });

  it('has independent count controls for every built-in identity and harness role', () => {
    expect(baseline.population.roles.map((row) => row.id).sort()).toEqual(['infra-reviewer', 'security-reviewer']);
    expect(baseline.population.roleCount).toBe(baseline.population.roles.length);
    expect(baseline.population.builtInIdentityCount).toBe(baseline.population.builtInIdentities.length);
    expect(baseline.population.builtInIdentityCount).toBe(29);
    expect(new Set(baseline.population.builtInIdentities.map((row) => row.id)).size).toBe(29);
  });

  it('freezes every launched tool argument schema, not only tool names', () => {
    expect(baseline.toolCatalog.sourceKind).toBe('real-launched-codex-managed-tool-prompts');
    expect(baseline.toolCatalog.count).toBe(baseline.toolCatalog.tools.length);
    expect(baseline.toolCatalog.count).toBeGreaterThan(1_000);
    for (const tool of baseline.toolCatalog.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.schema).toEqual(expect.objectContaining({ type: 'object' }));
      expect(tool.schemaSha256).toBe(sha256(JSON.stringify(tool.schema)));
    }
  });

  it('retains session/timestamp evidence or an explicit measured refusal for the stored samples', () => {
    expect(baseline.observations.length).toBeGreaterThanOrEqual(20);
    for (const row of baseline.observations) {
      expect(row.identity).toBeTruthy();
      expect(row.observedAt).toMatch(/^2026-10-22T/);
      if (row.status === 'observed') expect(row.ownerId).toMatch(/^su-/);
      else expect(row.refusal).toBeTruthy();
    }
    expect(baseline.observations.some((row) => row.status === 'launch-refused')).toBe(true);
    expect(baseline.knownDefect).toBe('EI-26700090355079325');
  });

  it('rejects the incomplete frozen samples as population-wide tool evidence', () => {
    const coverage = inspectIdopP001Coverage(baseline);
    expect(coverage.complete).toBe(false);
    expect(coverage.missing).toEqual(expect.arrayContaining([
      'role:infra-reviewer', 'role:security-reviewer', 'identity:su',
      'identity:su.mode-auto', 'identity:su.mode-audit', 'identity:su.mode-ideate',
    ]));
    expect(coverage.invalid).toContain('identity:su.mode-auto');
  });

  it('binds the supplemental role catalogs to real launches and complete argument-schema receipts', () => {
    const receipt = JSON.parse(readFileSync(join(root,
      'docs/evidence/idop-p001-role-tool-receipts-2026-10-22.json'), 'utf8')) as {
      frozenBaselineSha256: string;
      receipts: Array<{
        role: string; advSessionId: number; ownerId: string; nativeSessionId: string;
        sourceKind: string; sourceHome: string; nativeTranscript: string;
        launchAt: string; capturedAt: string; count: number; promptFileCount: number;
        catalogSha256: string; sourceFiles: Array<{ name: string; sha256: string }>;
      }>;
      catalogs: Record<string, Array<{ name: string; schema: unknown; schemaSha256: string }>>;
    };
    expect(receipt.frozenBaselineSha256).toBe(sha256(readFileSync(join(root, IDOP_P001_BASELINE_REL))));
    expect(receipt.receipts.map(row => row.role).sort()).toEqual(
      baseline.population.roles.map(row => row.id).sort());
    for (const row of receipt.receipts) {
      expect(row.sourceKind).toBe('real-launched-codex-role-managed-tool-prompts');
      expect(row.advSessionId).toBeGreaterThan(0);
      expect(row.ownerId).toMatch(/^su-/);
      expect(row.sourceHome).toBe(`~/.papercusp/su-codex-homes/session-${row.advSessionId}`);
      expect(row.nativeTranscript.startsWith(`${row.sourceHome}/sessions/`)).toBe(true);
      expect(row.nativeTranscript).toContain(row.nativeSessionId);
      expect(Date.parse(row.launchAt)).toBeLessThanOrEqual(Date.parse(row.capturedAt));
      const tools = receipt.catalogs[row.catalogSha256];
      expect(tools).toBeDefined();
      expect(sha256(JSON.stringify(tools))).toBe(row.catalogSha256);
      expect(row.count).toBe(tools.length);
      expect(row.promptFileCount).toBe(row.count);
      expect(row.sourceFiles).toHaveLength(row.count);
      expect(new Set(row.sourceFiles.map(file => file.name)).size).toBe(row.count);
      expect(new Set(tools.map(tool => tool.name)).size).toBe(row.count);
      for (const file of row.sourceFiles) expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      for (const tool of tools) {
        expect(tool.schema).toEqual(expect.objectContaining({ type: 'object' }));
        expect(sha256(JSON.stringify(tool.schema))).toBe(tool.schemaSha256);
      }
      // The real role gate refused introspection; the launch catalog agrees.
      expect(tools.some(tool => tool.name === 'agent_tools:list')).toBe(false);
    }
  });

  it('requires exact population equality, even when duplicate observations meet a count floor', () => {
    const observed = { identity: 'one', ownerId: 'su-receipt', observedAt: '2026-10-22T16:00:00Z',
      status: 'observed' as const, toolInvocationId: 1,
      nativeSessionId: '11111111-1111-4111-8111-111111111111' };
    const input = { population: { roles: [], builtInIdentities: [{ id: 'one' }, { id: 'two' }] },
      observations: Array.from({ length: 30 }, () => ({ ...observed })) };
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: false, missing: ['identity:two'] });
    input.observations.push({ ...observed, identity: 'two', toolInvocationId: 2 });
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: true, missing: [], invalid: [] });
    input.population.builtInIdentities.push({ id: 'three' });
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: false, missing: ['identity:three'] });
  });

  it.each([undefined, null, '', ' \t\n'])(
    'rejects an observed census receipt without a native source session (%j)',
    (nativeSessionId) => {
      const observed = { identity: 'one', ownerId: 'su-receipt',
        observedAt: '2026-10-22T16:00:00Z', status: 'observed' as const,
        toolInvocationId: 1, nativeSessionId };
      const population = { roles: [], builtInIdentities: [{ id: 'one' }] };
      expect(inspectIdopP001Coverage({ population, observations: [observed] })).toMatchObject({
        complete: false, checked: [], missing: ['identity:one'], invalid: ['identity:one'],
      });
      expect(inspectIdopP001Coverage({ population, observations: [{ ...observed,
        nativeSessionId: '11111111-1111-4111-8111-111111111111' }] })).toMatchObject({
        complete: true, checked: ['identity:one'], missing: [], invalid: [],
      });
    },
  );

  it('resolves each captured launch tool to its exact schema without assuming selected modes were worn', () => {
    const manifest = JSON.parse(readFileSync(join(root,
      'docs/evidence/idop-p001-launch-tool-catalogs-2026-10-22.json'), 'utf8')) as {
      frozenBaselineSha256: string;
      receipts: Array<{
        identity: string; advSessionId: number; nativeSessionId: string; sourceHome: string; nativeTranscript: string;
        count: number; catalogSha256: string; specificationRevision: string;
        specificationInputRefs: string[]; selectedIdentityInSpecification: boolean; wornLayerLimitation?: string;
      }>;
      catalogs: Record<string, Array<{ name: string; schemaSha256: string }>>;
      extraSchemas: Record<string, unknown>;
    };
    expect(manifest.frozenBaselineSha256).toBe(sha256(readFileSync(join(root, IDOP_P001_BASELINE_REL))));
    const schemas = new Map(baseline.toolCatalog.tools.map(tool => [tool.schemaSha256, tool.schema]));
    for (const [hash, schema] of Object.entries(manifest.extraSchemas)) {
      expect(sha256(JSON.stringify(schema))).toBe(hash);
      schemas.set(hash, schema);
    }
    const audience = manifest.receipts.find(row => row.advSessionId === 49611)!;
    expect(audience.specificationInputRefs).toEqual(expect.arrayContaining([
      'papercusp-engineer', 'su-collaborator', 'papercup.audience-engineer',
    ]));
    for (const row of manifest.receipts) {
      const tools = manifest.catalogs[row.catalogSha256];
      expect(sha256(JSON.stringify(tools))).toBe(row.catalogSha256);
      expect(row.count).toBe(tools.length);
      expect(new Set(tools.map(tool => tool.name)).size).toBe(row.count);
      expect(row.sourceHome).toBe(`~/.papercusp/su-codex-homes/session-${row.advSessionId}`);
      expect(row.nativeTranscript.startsWith(`${row.sourceHome}/sessions/`)).toBe(true);
      expect(row.nativeTranscript).toContain(row.nativeSessionId);
      expect(row.specificationRevision).toMatch(/^[a-f0-9]{64}$/);
      expect(row.selectedIdentityInSpecification).toBe(row.specificationInputRefs.includes(row.identity));
      if (!row.selectedIdentityInSpecification) expect(row.wornLayerLimitation).toBeTruthy();
      for (const tool of tools) {
        const schema = schemas.get(tool.schemaSha256);
        expect(schema).toBeDefined();
        expect(sha256(JSON.stringify(schema))).toBe(tool.schemaSha256);
      }
    }
  });

  it('rejects duplicate population members, unknown identities and receipt-free assertions', () => {
    const input = { population: { roles: [], builtInIdentities: [{ id: 'one' }, { id: 'one' }] },
      observations: [{ identity: 'one', ownerId: 'su-receipt', observedAt: '2026-10-22T16:00:00Z',
        status: 'observed' as const, toolInvocationId: 1,
        nativeSessionId: '11111111-1111-4111-8111-111111111111' }] };
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: false, duplicatePopulation: ['identity:one'] });
    input.population.builtInIdentities.pop();
    input.observations[0].toolInvocationId = 0;
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: false, invalid: ['identity:one'] });
    input.observations[0] = { ...input.observations[0], identity: 'unknown', toolInvocationId: 1 };
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: false, invalid: ['identity:unknown'] });
  });

  it('keeps authentic access refusals explicit without treating them as complete tool-set evidence', () => {
    const input = { population: { roles: [{ id: 'reviewer' }], builtInIdentities: [] },
      observations: [{ identity: 'reviewer', ownerId: 'su-reviewer', observedAt: '2026-10-22T16:00:00Z',
        status: 'tool-refused' as const, toolInvocationId: 1, refusal: 'role_not_allowed',
        nativeSessionId: '11111111-1111-4111-8111-111111111111' }] };
    expect(inspectIdopP001Coverage(input)).toMatchObject({
      complete: false, checked: [], refused: ['role:reviewer'], missing: [], invalid: [],
    });
    expect(inspectIdopP001Coverage({ ...input, observations: [{ ...input.observations[0],
      status: 'launch-refused', toolInvocationId: undefined }] })).toMatchObject({
      complete: false, refused: [], invalid: ['role:reviewer'],
    });
  });

  it('binds follow-up evidence to the unchanged frozen artifact and preserves unresolved coverage', () => {
    const audit = JSON.parse(readFileSync(join(root, 'docs/evidence/idop-p001-coverage-audit-2026-10-22.json'), 'utf8'));
    expect(audit.baseline.sha256).toBe(sha256(readFileSync(join(root, IDOP_P001_BASELINE_REL))));
    expect(audit.modeAutoCatalogMapping.sourceHome).toBe(
      `~/.papercusp/su-codex-homes/session-${audit.modeAutoCatalogMapping.advSessionId}`);
    for (const artifact of [audit.launchToolCatalogs, audit.roleLaunchCatalogs, audit.currentLeaderToolReceipt]) {
      expect(sha256(readFileSync(join(root, artifact.path)))).toBe(artifact.sha256);
    }
    const leader = JSON.parse(readFileSync(join(root, audit.currentLeaderToolReceipt.path), 'utf8'));
    expect(leader.sourceReceipt.path).toMatch(/^~\/\.papercusp\/scratch\//);
    expect(audit.ready).toBe(false);
    const unresolved = audit.unresolved.map((row: { identity: string }) => row.identity) as string[];
    const resolved = audit.resolvedWornToolMappings as Array<{
      identity: string; activationEventId: number; catalogSource: string;
    }>;
    expect(unresolved.length).toBeGreaterThan(0);
    expect([...unresolved, ...resolved.map(row => row.identity)].sort()).toEqual([
      'su', 'su.practice', 'su.mode-auto', 'su.mode-audit', 'su.mode-ideate', 'su.fleet-leader', 'su.fleet-member',
    ].sort());
    const applied = [...audit.appliedLayerReceipts, leader.appliedActivation] as Array<{
      id: string; phase: string; stack_refs: string[];
    }>;
    for (const mapping of resolved) {
      expect(audit[mapping.catalogSource]).toBeDefined();
      const activation = applied.find(row => Number(row.id) === mapping.activationEventId);
      expect(activation?.phase).toBe('applied');
      expect(activation?.stack_refs.map(ref => ref.slice(ref.indexOf(':') + 1))).toContain(mapping.identity);
    }
    const coverage = inspectIdopP001Coverage({ ...baseline,
      observations: [...baseline.observations, ...audit.roleObservations] });
    expect(coverage.complete).toBe(false);
    expect(coverage.refused).toEqual(expect.arrayContaining(['role:infra-reviewer', 'role:security-reviewer']));
  });

  it('pins all four vault settings, override channels and design answers', () => {
    expect(Object.keys(baseline.vault.baseline).sort()).toEqual(['afterReadHolds', 'automaticRecall', 'grantTerms', 'transcriptVisibility']);
    expect(baseline.vault.supersededBy).toContain('#D-020');
    expect(baseline.overrideChannels).toEqual(expect.arrayContaining(['?superuser=1 legacy query parameter', 'principal.kind / authenticated principal']));
    expect(Object.keys(baseline.answers).sort()).toEqual([
      'baseKnobsAndParams', 'consentAndProviderCapacity', 'directoryGroups', 'governanceSeesWornIdentity',
      'installConsent', 'p016AndP019', 'secrets',
    ]);
  });
});
