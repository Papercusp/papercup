import { describe, expect, it } from 'vitest';
import { decideLoopExecutionRecovery, type ExecutionRecoveryInput } from './loop-execution-recovery';

const nowMs = 1_000_000;
function fixture(): ExecutionRecoveryInput {
  return { ownerId: 'su-recovery', active: true, parked: true, firedAt: nowMs - 60_000, nowMs,
    host: { ownerId: 'su-recovery', advSessionId: null, pid: 1, ptyPid: 2, sock: '/fixture', command: 'codex',
      startedAt: nowMs - 100_000, execution: { phase: 'failed', turnStartedAt: nowMs - 60_000,
        lastProgressAt: nowMs - 40_000, pendingTools: 0, observedAt: nowMs,
        ownerId: 'su-recovery', hostPid: 1, childPid: 2, childGeneration: 1, receivedAtMs: nowMs - 60_000 } },
    inference: { active: 0, observedAt: nowMs } };
}

describe('expected loop execution recovery', () => {
  it('retains a paced recovery deadline without relying on provider error wording', () => {
    const first = decideLoopExecutionRecovery(fixture());
    expect(first).toMatchObject({ action: 'recover', state: { status: 'recovering', attempts: 1, nextProbeAt: nowMs + 30_000 } });
    const afterRestart = fixture();
    afterRestart.prior = JSON.parse(JSON.stringify(first.state));
    expect(decideLoopExecutionRecovery(afterRestart)).toMatchObject({ action: 'protect', state: { reason: 'recovery-backoff' } });
    afterRestart.nowMs += 30_000;
    afterRestart.host.execution!.observedAt = afterRestart.nowMs;
    afterRestart.inference.observedAt = afterRestart.nowMs;
    expect(decideLoopExecutionRecovery(afterRestart)).toMatchObject({ action: 'recover', state: { attempts: 2, nextProbeAt: nowMs + 90_000 } });
  });

  it.each([
    ['deliberate-stop', (i: ExecutionRecoveryInput) => { i.active = false; }],
    ['intentional-cadence', (i: ExecutionRecoveryInput) => { i.parked = false; }],
    ['provider-hold', (i: ExecutionRecoveryInput) => { i.host.quotaBlocked = true; }],
    ['owner-input', (i: ExecutionRecoveryInput) => { i.host.execution!.ownerInputPending = true; }],
    ['owner-stop', (i: ExecutionRecoveryInput) => { i.host.execution!.ownerStopRequested = true; }],
    ['active-inference', (i: ExecutionRecoveryInput) => { i.inference.active = 1; }],
    ['native-operation', (i: ExecutionRecoveryInput) => { i.host.execution!.phase = 'running'; }],
    ['native-operation', (i: ExecutionRecoveryInput) => { i.host.execution!.pendingTools = 1; }],
  ] as const)('protects %s', (reason, change) => {
    const i = fixture(); change(i);
    expect(decideLoopExecutionRecovery(i)).toMatchObject({ action: 'protect', state: { reason, attempts: 0 } });
  });

  it.each([
    (i: ExecutionRecoveryInput) => { delete i.host.execution; },
    (i: ExecutionRecoveryInput) => { i.host.execution!.ownerId = 'someone-else'; },
    (i: ExecutionRecoveryInput) => { i.host.execution!.hostPid = 99; },
    (i: ExecutionRecoveryInput) => { i.host.execution!.childPid = 99; },
    (i: ExecutionRecoveryInput) => { i.host.execution!.observedAt -= 16_000; },
    (i: ExecutionRecoveryInput) => { i.host.execution!.observedAt++; },
    (i: ExecutionRecoveryInput) => { delete i.host.execution!.childGeneration; },
    (i: ExecutionRecoveryInput) => { i.host.execution!.receivedAtMs = i.host.startedAt - 1; },
    (i: ExecutionRecoveryInput) => { i.inference.active = null; },
  ])('keeps absent, stale and mismatched proof unknown', change => {
    const i = fixture(); change(i);
    expect(decideLoopExecutionRecovery(i)).toMatchObject({ action: 'observe', state: { status: 'unknown', attempts: 0 } });
  });

  it('bounds unknown-state probing and retains an explicit recoverable block', () => {
    const i = fixture(); i.host.execution!.phase = 'unknown';
    for (let n = 0; n < 3; n++) {
      const decision = decideLoopExecutionRecovery(i);
      i.prior = decision.state;
      i.nowMs = decision.state.nextProbeAt;
      i.host.execution!.observedAt = i.nowMs;
      i.inference.observedAt = i.nowMs;
    }
    expect(i.prior).toMatchObject({ status: 'blocked', reason: 'native-start-unverified', probes: 3, attempts: 0 });
    i.host.execution!.phase = 'failed';
    expect(decideLoopExecutionRecovery(i).action).toBe('recover');
  });

  it('does not retry forever after repeated starts fail', () => {
    const i = fixture();
    for (let n = 0; n < 5; n++) {
      const decision = decideLoopExecutionRecovery(i);
      expect(decision.action).toBe('recover');
      i.prior = decision.state;
      i.nowMs = decision.state.nextProbeAt;
      i.host.execution!.observedAt = i.nowMs;
      i.inference.observedAt = i.nowMs;
    }
    expect(decideLoopExecutionRecovery(i)).toMatchObject({ action: 'block', state: { status: 'blocked', reason: 'native-start-retry-exhausted' } });
  });

  it('requires current-fire completion before using the normal settle path', () => {
    const i = fixture(); i.host.execution!.phase = 'settled';
    expect(decideLoopExecutionRecovery(i).action).toBe('settle');
    i.host.execution!.lastProgressAt = i.firedAt - 1;
    expect(decideLoopExecutionRecovery(i).action).toBe('observe');
  });
});
