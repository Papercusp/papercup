import { describe, expect, it } from 'vitest';
import {
  PHASE_E_INPUT_SCHEMA,
  PHASE_E_MODE_CHANGE_SCHEMA,
  PHASE_E_MUTATION_SCHEMA,
  PHASE_E_OBSERVATION_SCHEMA,
  PHASE_E_RECOVERY_SCHEMA,
  PHASE_E_WATCHDOG_SCHEMA,
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

function trigger(
  host: 'tower' | 'vm',
  role: PhysicalPhaseETrigger['role'],
  minute: number,
): PhysicalPhaseETrigger {
  return {
    tool: 'git-sync:run',
    installSlug: 'hello-world-3-pot',
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
