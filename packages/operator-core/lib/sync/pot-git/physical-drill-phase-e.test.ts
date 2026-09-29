import { describe, expect, it } from 'vitest';
import { physicalDrillGitSyncSlug } from './physical-drill-phase-a';
import {
  PHASE_E_INPUT_SCHEMA,
  PHASE_E_MODE_CHANGE_SCHEMA,
  PHASE_E_MUTATION_SCHEMA,
  PHASE_E_OBSERVATION_SCHEMA,
  PHASE_E_RECOVERY_SCHEMA,
  PHASE_E_WATCHDOG_SCHEMA,
  PHASE_E_MODE_POLL_MS,
  PHASE_E_MODE_WAIT_MAX_MS,
  awaitPhysicalPhaseEStageMode,
  capturePhysicalPhaseEObservation,
  ensurePhysicalPhaseEMode,
  preflightPhysicalPhaseERemotes,
  setPhysicalPhaseEMode,
  validatePhysicalPhaseE,
  type PhysicalPhaseEInput,
  type PhysicalPhaseEObservation,
  type PhysicalPhaseETrigger,
} from './physical-drill-phase-e';

const RUN = 'phase-e-run-0001';
const TOWER = Buffer.alloc(32, 1).toString('base64');
const VM = Buffer.alloc(32, 2).toString('base64');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const E = 'e'.repeat(40);
const START = '2026-08-13T20:00:00.000Z';
const END = '2026-08-13T21:00:00.000Z';
const REMOTE_CONTEXT = {
  repoPath: '/fixed/hello-world-3-pot.git',
  upstream: 'https://github.com/papercupai/hello-world-3-pot.git',
  fork: 'https://github.com/aviynw/hello-world-3-pot.git',
  defaultBranch: 'staging',
};

function trigger(
  host: 'tower' | 'vm',
  role: PhysicalPhaseETrigger['role'],
  minute: number,
): PhysicalPhaseETrigger {
  return {
    tool: 'git-sync:run',
    installSlug: physicalDrillGitSyncSlug(host),
    host,
    role,
    fired: true,
    startedAt: `2026-08-13T20:${String(minute).padStart(2, '0')}:00.000Z`,
    finishedAt: `2026-08-13T20:${String(minute).padStart(2, '0')}:30.000Z`,
  };
}

function observation(opts: {
  host: 'tower' | 'vm';
  key: string;
  stage: PhysicalPhaseEObservation['stage'];
  mode: 'legacy' | 'bridged';
  canonical?: string;
  upstream?: string;
  remote?: string;
  bridge?: PhysicalPhaseEObservation['routine']['githubBridge'];
  bridgeEscalation?: Record<string, unknown> | null;
}): PhysicalPhaseEObservation {
  return {
    schemaVersion: PHASE_E_OBSERVATION_SCHEMA,
    runId: RUN,
    hostId: opts.host,
    deviceKey: opts.key,
    stage: opts.stage,
    observedAt: '2026-08-13T20:20:00.000Z',
    mode: { value: opts.mode, source: 'set' },
    routine: {
      active: true,
      lastFiredAt: '2026-08-13T20:19:30.000Z',
      pushMode: opts.mode === 'bridged' ? 'commit-only:bridged' : 'push',
      lastStatus: 'synced',
      lastPushed: [],
      headSha: D,
      watchdogAlerted: false,
      watchdogErrorSweeps: 0,
      watchdogStallSweeps: 0,
      githubBridge: opts.bridge ?? null,
    },
    refs: {
      canonicalStaging: opts.canonical ?? C,
      upstreamDefault: opts.upstream ?? A,
      remoteStaging: opts.remote ?? C,
    },
    bridgeEscalation: opts.bridgeEscalation ?? null,
    watchdogEscalation: null,
  };
}

function validInput(): PhysicalPhaseEInput {
  const clearBridge: NonNullable<PhysicalPhaseEObservation['routine']['githubBridge']> = {
    at: Date.parse('2026-08-13T20:19:00.000Z'),
    ran: true,
    skipped: null,
    egressTarget: 'fork',
    lastAdmitted: B,
    egressHead: D,
    divergence: 'clear',
    needsOwner: false,
    errors: [],
  };
  return {
    schemaVersion: PHASE_E_INPUT_SCHEMA,
    runId: RUN,
    window: { startedAt: START, finishedAt: END },
    identities: { towerDeviceKey: TOWER, vmDeviceKey: VM },
    before: {
      tower: observation({ host: 'tower', key: TOWER, stage: 'legacy-before', mode: 'legacy' }),
      vm: observation({ host: 'vm', key: VM, stage: 'legacy-before', mode: 'legacy' }),
    },
    activation: {
      modeChange: {
        schemaVersion: PHASE_E_MODE_CHANGE_SCHEMA,
        runId: RUN,
        hostId: 'tower',
        tool: 'setPotGitMode',
        from: 'legacy',
        to: 'bridged',
        workspaceId: 'papercusp-workspace',
        potHomeSlug: 'hello-world-3-pot',
        observedAt: '2026-08-13T20:01:00.000Z',
      },
      towerTrigger: trigger('tower', 'tower-member', 2),
      vmTrigger: trigger('vm', 'vm-member', 3),
      tower: observation({ host: 'tower', key: TOWER, stage: 'bridged-member', mode: 'bridged' }),
      vm: observation({ host: 'vm', key: VM, stage: 'bridged-member', mode: 'bridged' }),
    },
    healthy: {
      ingressMutation: {
        schemaVersion: PHASE_E_MUTATION_SCHEMA,
        runId: RUN,
        kind: 'ingress',
        hostId: 'tower',
        method: 'fixed-empty-commit-ff-push',
        remoteRole: 'upstream',
        remoteRef: 'refs/heads/main',
        baseOid: A,
        canonicalOid: C,
        headOid: B,
        createdAt: '2026-08-13T20:04:00.000Z',
      },
      ingressTrigger: trigger('tower', 'healthy-ingress', 5),
      integrateTrigger: trigger('tower', 'healthy-integrate', 6),
      egressTrigger: trigger('tower', 'healthy-egress', 7),
      observation: observation({
        host: 'tower', key: TOWER, stage: 'healthy-egress', mode: 'bridged',
        canonical: D, upstream: B, remote: D, bridge: clearBridge,
      }),
    },
    watchdogSweeps: [
      {
        schemaVersion: PHASE_E_WATCHDOG_SCHEMA,
        runId: RUN,
        hostId: 'tower',
        ordinal: 1,
        tool: 'checkGitSyncStall',
        startedAt: '2026-08-13T20:10:00.000Z',
        finishedAt: '2026-08-13T20:10:01.000Z',
        fixedRoutineActive: true,
        fixedPushMode: 'commit-only:bridged',
        fixedWatchdogAlerted: false,
        fixedWatchdogErrorSweeps: 0,
        fixedWatchdogStallSweeps: 0,
        alarmed: [],
        recovered: [],
      },
      {
        schemaVersion: PHASE_E_WATCHDOG_SCHEMA,
        runId: RUN,
        hostId: 'tower',
        ordinal: 2,
        tool: 'checkGitSyncStall',
        startedAt: '2026-08-13T20:25:00.000Z',
        finishedAt: '2026-08-13T20:25:01.000Z',
        fixedRoutineActive: true,
        fixedPushMode: 'commit-only:bridged',
        fixedWatchdogAlerted: false,
        fixedWatchdogErrorSweeps: 0,
        fixedWatchdogStallSweeps: 0,
        alarmed: [],
        recovered: [],
      },
    ],
    divergence: {
      before: observation({ host: 'tower', key: TOWER, stage: 'divergence-before', mode: 'bridged', canonical: D, upstream: B, remote: D, bridge: clearBridge }),
      mutation: {
        schemaVersion: PHASE_E_MUTATION_SCHEMA,
        runId: RUN,
        kind: 'fork-ahead',
        hostId: 'tower',
        method: 'fixed-empty-commit-ff-push',
        remoteRole: 'fork',
        remoteRef: 'refs/heads/staging',
        baseOid: D,
        canonicalOid: D,
        headOid: E,
        createdAt: '2026-08-13T20:30:00.000Z',
      },
      trigger: trigger('tower', 'divergence-egress', 31),
      after: observation({
        host: 'tower', key: TOWER, stage: 'divergence-after', mode: 'bridged', canonical: D, upstream: B, remote: E,
        bridge: { ...clearBridge, divergence: 'escalate' },
        bridgeEscalation: { kind: 'github-bridge-divergence', signals: [{ kind: 'egress-non-ff', localSha: D, remoteSha: E }] },
      }),
      recovery: {
        schemaVersion: PHASE_E_RECOVERY_SCHEMA,
        runId: RUN,
        hostId: 'tower',
        method: 'fixed-force-with-lease-restore',
        remoteRef: 'refs/heads/staging',
        expectedDivergenceOid: E,
        restoredOid: D,
        observedRemoteOid: D,
        observedAt: '2026-08-13T20:35:00.000Z',
      },
    },
    rollback: {
      modeChange: {
        schemaVersion: PHASE_E_MODE_CHANGE_SCHEMA,
        runId: RUN,
        hostId: 'tower',
        tool: 'setPotGitMode',
        from: 'bridged',
        to: 'legacy',
        workspaceId: 'papercusp-workspace',
        potHomeSlug: 'hello-world-3-pot',
        observedAt: '2026-08-13T20:40:00.000Z',
      },
      towerTrigger: trigger('tower', 'rollback-observe', 41),
      vmTrigger: trigger('vm', 'rollback-observe', 42),
      tower: observation({ host: 'tower', key: TOWER, stage: 'legacy-after', mode: 'legacy', canonical: D, upstream: B, remote: D }),
      vm: observation({ host: 'vm', key: VM, stage: 'legacy-after', mode: 'legacy', canonical: D, upstream: B, remote: D }),
    },
  };
}

describe('validatePhysicalPhaseE', () => {
  it('preflights fixed remotes and exact starting refs without a mutating git command', async () => {
    const calls: string[][] = [];
    const permissions: string[] = [];
    const runGit = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${C}\n`, stderr: '' };
      if (args[0] === 'ls-remote' && args[3] === 'refs/heads/staging') {
        return { code: 0, stdout: `${args[2] === REMOTE_CONTEXT.fork ? C : A}\t${args[3]}\n`, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected git command' };
    };

    await expect(preflightPhysicalPhaseERemotes({
      remoteContext: REMOTE_CONTEXT,
      runGit,
      fetchPushPermission: async (owner, repo) => {
        permissions.push(`${owner}/${repo}`);
        return true;
      },
    })).resolves.toMatchObject({
      ready: true,
      defaultBranch: 'staging',
      refs: { canonicalStaging: C, upstreamDefault: A, forkStaging: C },
      permissions: { upstreamPush: true, forkPush: true },
    });
    expect(permissions).toEqual([
      'papercupai/hello-world-3-pot',
      'aviynw/hello-world-3-pot',
    ]);
    expect(calls.every((args) => args[0] === 'rev-parse' || args[0] === 'ls-remote')).toBe(true);
  });

  it('rejects a missing fixed fork before any git or permission probe', async () => {
    let gitCalls = 0;
    let permissionCalls = 0;
    await expect(preflightPhysicalPhaseERemotes({
      loadRegistry: async () => ({
        projects: [{
          slug: 'hello-world-3-pot',
          github_remote: REMOTE_CONTEXT.upstream,
          github_default_branch: 'staging',
        }],
      }),
      runGit: async () => {
        gitCalls += 1;
        return { code: 0, stdout: '', stderr: '' };
      },
      fetchPushPermission: async () => {
        permissionCalls += 1;
        return true;
      },
    })).rejects.toThrow('requires both upstream and fork remotes');
    expect(gitCalls).toBe(0);
    expect(permissionCalls).toBe(0);
  });

  it('rejects unverified write permission before inspecting refs', async () => {
    let gitCalls = 0;
    await expect(preflightPhysicalPhaseERemotes({
      remoteContext: REMOTE_CONTEXT,
      runGit: async () => {
        gitCalls += 1;
        return { code: 0, stdout: '', stderr: '' };
      },
      fetchPushPermission: async (owner) => owner === 'papercupai' ? true : null,
    })).rejects.toThrow('physical Phase E fork push permission is unverified');
    expect(gitCalls).toBe(0);
  });

  it('refuses a non-Phase-E starting mode before writing the production setting', async () => {
    let writes = 0;
    await expect(setPhysicalPhaseEMode(
      { runId: RUN, mode: 'bridged' },
      {
        getMode: async () => 'p2p-only',
        setMode: async () => { writes += 1; },
      },
    )).rejects.toThrow('physical Phase E mode flip requires legacy before bridged; observed p2p-only');
    expect(writes).toBe(0);
  });

  describe('drill baseline, stage-mode wait and member observation (WI-10003791)', () => {
    // Every harness_shared query in the observation returns no rows.
    const emptySql = (async () => []) as unknown as NonNullable<Parameters<typeof capturePhysicalPhaseEObservation>[1]>['sql'];

    it('establishes a legacy baseline from a bridged canary with one production write', async () => {
      let mode: 'legacy' | 'bridged' | 'p2p-only' = 'bridged';
      const writes: string[] = [];
      const record = await ensurePhysicalPhaseEMode({ runId: RUN, mode: 'legacy' }, {
        getMode: async () => mode,
        setMode: async (_ws, _slug, next) => { writes.push(next); mode = next; },
      });
      expect(writes).toEqual(['legacy']);
      expect(record).toMatchObject({ from: 'bridged', to: 'legacy', changed: true, tool: 'setPotGitMode', hostId: 'tower' });
    });

    it('does not write when the canary is already in the requested mode', async () => {
      let writes = 0;
      const record = await ensurePhysicalPhaseEMode({ runId: RUN, mode: 'bridged' }, {
        getMode: async () => 'bridged',
        setMode: async () => { writes += 1; },
      });
      expect(writes).toBe(0);
      expect(record).toMatchObject({ from: 'bridged', to: 'bridged', changed: false });
    });

    it('refuses to move a canary out of a mode the drill does not own', async () => {
      let writes = 0;
      await expect(ensurePhysicalPhaseEMode({ runId: RUN, mode: 'legacy' }, {
        getMode: async () => 'p2p-only',
        setMode: async () => { writes += 1; },
      })).rejects.toThrow('physical Phase E refuses to change the canary out of mode p2p-only');
      expect(writes).toBe(0);
    });

    it('waits for the federated bridged row instead of reading once', async () => {
      let clock = 0;
      const reads = [
        { mode: 'legacy', source: 'set' },
        { mode: 'bridged', source: 'absent' },
        { mode: 'bridged', source: 'set' },
      ] as const;
      let i = 0;
      const mode = await awaitPhysicalPhaseEStageMode({ stage: 'bridged-member', waitMs: 60_000 }, {
        readMode: async () => reads[Math.min(i++, reads.length - 1)],
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
      });
      expect(mode).toEqual({ mode: 'bridged', source: 'set' });
      expect(i).toBe(3);
      expect(clock).toBe(2 * PHASE_E_MODE_POLL_MS);
    });

    it('returns the last read at the deadline so the validator judges the stale mode', async () => {
      let clock = 0;
      let reads = 0;
      const mode = await awaitPhysicalPhaseEStageMode({ stage: 'legacy-before', waitMs: 12_000 }, {
        readMode: async () => { reads += 1; return { mode: 'bridged', source: 'set' }; },
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
      });
      expect(mode).toEqual({ mode: 'bridged', source: 'set' });
      expect(clock).toBe(12_000);
      expect(reads).toBe(4);
    });

    it('bounds the wait', async () => {
      await expect(awaitPhysicalPhaseEStageMode(
        { stage: 'legacy-after', waitMs: PHASE_E_MODE_WAIT_MAX_MS + 1 },
        { readMode: async () => ({ mode: 'legacy', source: 'set' }) },
      )).rejects.toThrow('physical Phase E mode wait must be an integer');
    });

    it('observes a member without the bridge-only fork remote and without reading any remote', async () => {
      const gitArgs: string[][] = [];
      const observation = await capturePhysicalPhaseEObservation(
        { runId: RUN, hostId: 'vm', deviceKey: VM, stage: 'legacy-before' },
        {
          sql: emptySql,
          loadRegistry: async () => ({
            projects: [{ slug: 'hello-world-3-pot', github_remote: 'https://github.com/papercupai/hello-world-3-pot' }],
          }),
          readMode: async () => ({ mode: 'legacy', source: 'set' }),
          runGit: async (args) => {
            gitArgs.push(args);
            return { code: 0, stdout: `${A}\n`, stderr: '' };
          },
        },
      );
      expect(observation.refs).toEqual({ canonicalStaging: A, upstreamDefault: null, remoteStaging: null });
      expect(observation.mode).toEqual({ value: 'legacy', source: 'set' });
      expect(gitArgs.some((args) => args[0] === 'ls-remote')).toBe(false);
    });

    it('still requires both remotes on the tower, which is the bridge writer', async () => {
      await expect(capturePhysicalPhaseEObservation(
        { runId: RUN, hostId: 'tower', deviceKey: TOWER, stage: 'legacy-before' },
        {
          sql: emptySql,
          loadRegistry: async () => ({
            projects: [{ slug: 'hello-world-3-pot', github_remote: 'https://github.com/papercupai/hello-world-3-pot' }],
          }),
          readMode: async () => ({ mode: 'legacy', source: 'set' }),
          runGit: async () => ({ code: 0, stdout: `${A}\n`, stderr: '' }),
        },
      )).rejects.toThrow('requires both upstream and fork remotes');
    });
  });

  it('accepts the complete two-host production-spine causal object', () => {
    const verdict = validatePhysicalPhaseE(validInput());
    expect(verdict.errors).toEqual([]);
    expect(verdict.result).toMatchObject({ phase: 'E', planItem: 'P-306', complete: true });
  });

  it('rejects a bridged member that direct-pushed origin', () => {
    const input = validInput();
    input.activation.vm.routine.lastPushed = ['origin/staging'];
    expect(validatePhysicalPhaseE(input).errors).toContain('Phase E vm member must be active, commit-only:bridged, and record no direct pushes');
  });

  it('rejects a summary-shaped healthy leg without the exact admission watermark', () => {
    const input = validInput();
    input.healthy.observation.routine.githubBridge!.lastAdmitted = A;
    expect(validatePhysicalPhaseE(input).errors).toContain('Phase E healthy bridge must ingress and persist the exact fresh upstream head as last_admitted');
  });

  it('rejects remote staging that did not land at canonical', () => {
    const input = validInput();
    input.healthy.observation.refs.remoteStaging = C;
    expect(validatePhysicalPhaseE(input).errors).toContain('Phase E healthy bridge must clear divergence and FF exact canonical staging to the fork');
  });

  it('rejects a watchdog false alarm and a collapsed one-sweep witness', () => {
    const input = validInput();
    input.watchdogSweeps[1].alarmed = ['hello-world-3-pot'];
    input.watchdogSweeps[1].startedAt = input.watchdogSweeps[0].finishedAt;
    const errors = validatePhysicalPhaseE(input).errors;
    expect(errors.some((error) => error.includes('watchdog sweep 2'))).toBe(true);
    expect(errors).toContain('Phase E production watchdog sweeps must be distinct and ordered');
  });

  it('rejects divergence evidence whose canonical moved', () => {
    const input = validInput();
    input.divergence.after.refs.canonicalStaging = E;
    expect(validatePhysicalPhaseE(input).errors).toContain('Phase E fork-ahead control must yield egress-non-ff while canonical and remote remain unchanged');
  });

  it('rejects a prose escalation without the structured egress-non-ff signal', () => {
    const input = validInput();
    input.divergence.after.bridgeEscalation = { detail: 'non fast forward' };
    expect(validatePhysicalPhaseE(input).errors).toContain('Phase E fork-ahead control must yield egress-non-ff while canonical and remote remain unchanged');
  });

  it('rejects rollback that leaves either physical host bridged', () => {
    const input = validInput();
    input.rollback.vm.mode.value = 'bridged';
    expect(validatePhysicalPhaseE(input).errors).toContain('Phase E legacy-after must observe mode legacy');
  });
});
