import { describe, expect, it, vi } from 'vitest';
import {
  awaitDependencyPrebuildState,
  dependencyPrebuildKey,
  parseDependencyPrebuildState,
  runDependencyGenerationPrebuild,
  type DependencyPrebuildBuildingState,
  type DependencyPrebuildCommand,
  type DependencyPrebuildReadyState,
  type DependencyPrebuildState,
} from './dependency-generation-prebuild';

const CANDIDATE_A = 'a'.repeat(40);
const CANDIDATE_B = 'b'.repeat(40);
const INPUT = 'c'.repeat(64);
const IDENTITY = `v1-${'d'.repeat(64)}`;
const TOKEN = `v2:${'e'.repeat(64)}`;
const TARGET = { workspaceId: 'ws-1', installSlug: 'papercusp' };

function building(candidate = CANDIDATE_A, inputFingerprint = INPUT): DependencyPrebuildBuildingState {
  return {
    schema: 1,
    status: 'building',
    key: dependencyPrebuildKey(candidate, inputFingerprint),
    candidate,
    inputFingerprint,
    attemptId: 'attempt-1',
    queuedAtMs: 100,
    startedAtMs: 101,
    updatedAtMs: 102,
    completedAtMs: null,
    producerPid: 7,
    childPid: null,
  };
}

function ready(candidate = CANDIDATE_A, inputFingerprint = INPUT): DependencyPrebuildReadyState {
  return {
    ...building(candidate, inputFingerprint),
    status: 'ready',
    updatedAtMs: 110,
    completedAtMs: 110,
    identity: IDENTITY,
    token: TOKEN,
    reused: true,
  };
}

function fingerprintResult(candidate: string) {
  return {
    code: 0,
    stdout: `DEPENDENCY_INPUT_FINGERPRINT schema=1 candidate=${candidate} input=${INPUT}\n`,
    stderr: '',
  };
}

describe('dependency generation background prebuild', () => {
  it('claims candidate+input once, publishes through the existing helper, then persists/emits ready', async () => {
    const calls: string[][] = [];
    let state: DependencyPrebuildState | null = null;
    const emitted: DependencyPrebuildState[] = [];
    let clock = 1_000;
    const command: DependencyPrebuildCommand = vi.fn(async (_command, args, options) => {
      calls.push(args);
      if (args.includes('--fingerprint-ref')) return fingerprintResult(CANDIDATE_A);
      options.onSpawn?.(4321);
      options.onProgress?.();
      return {
        code: 0,
        stdout:
          `DEPENDENCY_GENERATION_RESULT schema=1 identity=${IDENTITY} source=fixture ` +
          `input=${INPUT} scope=full reused=true token=${TOKEN} path=/generation\n`,
        stderr: '',
      };
    });

    const outcome = await runDependencyGenerationPrebuild(
      {
        ...TARGET,
        candidate: CANDIDATE_A,
        integrationRoot: '/integration',
        toolingRoot: '/tooling',
        queuedAtMs: 999,
      },
      {
        command,
        now: () => clock++,
        attemptId: () => 'attempt-1',
        readState: async () => state,
        claimState: async (_target, next) => {
          state = next;
          return true;
        },
        heartbeatState: async (_target, next) => {
          state = next;
          return true;
        },
        settleState: async (_target, next) => {
          state = next;
          return true;
        },
        emitTerminal: async (_target, terminal) => {
          emitted.push(terminal);
        },
      },
    );

    expect(outcome).toBe('ready');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--fingerprint-ref');
    expect(calls[1]).toContain('--ensure-ref');
    expect(state).toMatchObject({
      status: 'ready',
      candidate: CANDIDATE_A,
      inputFingerprint: INPUT,
      identity: IDENTITY,
      token: TOKEN,
      childPid: 4321,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ status: 'ready', identity: IDENTITY });
  });

  it('dedupes an exact ready marker before running or claiming the publisher', async () => {
    const claimState = vi.fn(async () => true);
    const command: DependencyPrebuildCommand = vi.fn(async (_command, args) => {
      expect(args).toContain('--fingerprint-ref');
      return fingerprintResult(CANDIDATE_A);
    });

    const outcome = await runDependencyGenerationPrebuild(
      {
        ...TARGET,
        candidate: CANDIDATE_A,
        integrationRoot: '/integration',
        toolingRoot: '/tooling',
      },
      {
        command,
        readState: async () => ready(),
        claimState,
      },
    );

    expect(outcome).toBe('deduped-ready');
    expect(command).toHaveBeenCalledOnce();
    expect(claimState).not.toHaveBeenCalled();
  });

  it('re-keys a ready generation for a new candidate with identical inputs without rebuilding', async () => {
    const prior = ready(CANDIDATE_A);
    let settled: DependencyPrebuildState | null = null;
    const command: DependencyPrebuildCommand = vi.fn(async (_command, args) => {
      expect(args).toContain('--fingerprint-ref');
      return fingerprintResult(CANDIDATE_B);
    });

    const outcome = await runDependencyGenerationPrebuild(
      {
        ...TARGET,
        candidate: CANDIDATE_B,
        integrationRoot: '/integration',
        toolingRoot: '/tooling',
      },
      {
        command,
        readState: async () => prior,
        claimState: async () => true,
        settleState: async (_target, next) => {
          settled = next;
          return true;
        },
        emitTerminal: async () => {},
        attemptId: () => 'attempt-b',
      },
    );

    expect(outcome).toBe('ready');
    expect(command).toHaveBeenCalledOnce();
    expect(settled).toMatchObject({
      status: 'ready',
      candidate: CANDIDATE_B,
      inputFingerprint: INPUT,
      identity: IDENTITY,
      token: TOKEN,
      reused: true,
    });
  });

  it('persists and emits a failed terminal marker when the existing publisher refuses', async () => {
    let settled: DependencyPrebuildState | null = null;
    const emitted: DependencyPrebuildState[] = [];
    const command: DependencyPrebuildCommand = vi.fn(async (_command, args) =>
      args.includes('--fingerprint-ref')
        ? fingerprintResult(CANDIDATE_A)
        : {
            code: 74,
            stdout: '',
            stderr: 'FATAL: no prewarmed dependency generation for input fingerprint fixture',
          },
    );

    const outcome = await runDependencyGenerationPrebuild(
      {
        ...TARGET,
        candidate: CANDIDATE_A,
        integrationRoot: '/integration',
        toolingRoot: '/tooling',
      },
      {
        command,
        readState: async () => null,
        claimState: async () => true,
        settleState: async (_target, next) => {
          settled = next;
          return true;
        },
        emitTerminal: async (_target, next) => {
          emitted.push(next);
        },
        attemptId: () => 'attempt-failed',
      },
    );

    expect(outcome).toBe('failed');
    expect(settled).toMatchObject({
      status: 'failed',
      candidate: CANDIDATE_A,
      error: expect.stringContaining('exited 74'),
    });
    expect(emitted).toHaveLength(1);
  });
});

describe('dependency prebuild state/wait contract', () => {
  it('rejects malformed or mismatched ready metadata instead of treating it as usable', () => {
    expect(parseDependencyPrebuildState({ ...ready(), token: '' })).toBeNull();
    expect(
      parseDependencyPrebuildState({
        ...ready(),
        key: dependencyPrebuildKey(CANDIDATE_B, INPUT),
      }),
    ).toBeNull();
    expect(parseDependencyPrebuildState(ready())).toMatchObject({
      status: 'ready',
      identity: IDENTITY,
    });
  });

  it('subscribes before reading and resolves the exact terminal edge, with state authoritative', async () => {
    let state: DependencyPrebuildState = building();
    let handler!: (payload: string) => void;
    const unsubscribe = vi.fn();
    const pending = awaitDependencyPrebuildState(
      TARGET,
      CANDIDATE_A,
      INPUT,
      { timeoutMs: 5_000, reconcileMs: 5_000 },
      {
        readState: async () => state,
        subscribe: (next) => {
          handler = next;
          return unsubscribe;
        },
      },
    );

    await Promise.resolve();
    state = ready();
    handler(
      JSON.stringify({
        ...TARGET,
        candidate: CANDIDATE_A,
        inputFingerprint: INPUT,
        status: 'ready',
      }),
    );

    await expect(pending).resolves.toMatchObject({
      status: 'ready',
      identity: IDENTITY,
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
