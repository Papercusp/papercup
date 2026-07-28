/**
 * WI-6594 — the stamp must survive being split across cluster workers.
 *
 * The headline test (`the regression`) is a faithful model of what actually
 * happened on 2026-07-28: `coord:declare-intent` lands on one worker,
 * `work_items:claim` on another, and every later call must still stamp BOTH. Run
 * it against the pre-fix module and it fails on exactly the symptom the fleet gate
 * saw — a null goal for an agent that holds one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  noteIntentDeclared,
  noteGoalClaimed,
  noteAssumptionAsserted,
  readAgentStateStamp,
  resetAgentStateStamps,
  applyReplicatedStamp,
  setAgentStampPublisher,
  type AgentStampPatchEvent,
} from './agent-state-stamp';
import {
  AGENT_STAMP_PATCH_TYPE,
  isAgentStampPatchMessage,
  startWorkerStampPublisher,
  startWorkerStampReceiver,
  startPrimaryStampRelay,
  type AgentStampPatchMessage,
} from './agent-state-stamp-cluster';

const OWNER = 'su-3ff0da85-3a06-42c9-ba3e-cda3c61c1487';

beforeEach(() => {
  resetAgentStateStamps();
});

/**
 * One process's view of the shared module state.
 *
 * The stamp map is module-scoped, so a single test process cannot literally hold
 * two of them. Instead each "worker" is a capture/replay pair: its declarations
 * are captured as patch events, and a worker is "resumed" by clearing the map and
 * replaying the patches that process has seen. That models the ONE property under
 * test — that a process only knows the declarations delivered to it.
 */
class FakeWorker {
  readonly seen: AgentStampPatchEvent[] = [];
  constructor(readonly relay: (event: AgentStampPatchEvent) => void) {}

  /** Make this worker's map the live one, then run `fn` as that worker. */
  run<T>(fn: () => T): T {
    resetAgentStateStamps();
    for (const e of this.seen) applyReplicatedStamp(e);
    setAgentStampPublisher((event) => {
      this.seen.push(event);
      this.relay(event);
    });
    return fn();
  }
}

describe('WI-6594 — cluster-split declarations', () => {
  it('the regression: intent on one worker + goal on another still stamps BOTH', () => {
    const workers: FakeWorker[] = [];
    // The primary's relay: fan every declaration out to every worker's view.
    const relay = (event: AgentStampPatchEvent) => {
      for (const w of workers) if (!w.seen.includes(event)) w.seen.push(event);
    };
    const a = new FakeWorker(relay);
    const b = new FakeWorker(relay);
    workers.push(a, b);

    // Worker A serves coord:declare-intent.
    a.run(() => noteIntentDeclared(OWNER, 8283136));
    // Worker B serves work_items:claim — a DIFFERENT process.
    b.run(() => noteGoalClaimed(OWNER, 'WI-6502'));

    // The next tool call may be dispatched by either worker. Both must stamp the
    // agent's full declared state; before the fix each held exactly half.
    expect(a.run(() => readAgentStateStamp(OWNER))).toEqual({
      intentEventId: 8283136,
      assumptionSetId: null,
      goalRef: 'WI-6502',
    });
    expect(b.run(() => readAgentStateStamp(OWNER))).toEqual({
      intentEventId: 8283136,
      assumptionSetId: null,
      goalRef: 'WI-6502',
    });
  });

  it('a release (goalRef -> null) replicates too', () => {
    const events: AgentStampPatchEvent[] = [];
    setAgentStampPublisher((e) => events.push(e));
    noteGoalClaimed(OWNER, 'WI-6502');
    noteGoalClaimed(OWNER, null);

    resetAgentStateStamps(); // a peer worker, which saw only the replicated stream
    for (const e of events) applyReplicatedStamp(e);
    expect(readAgentStateStamp(OWNER).goalRef).toBeNull();
  });
});

describe('applyReplicatedStamp ordering', () => {
  it('never rewinds intentEventId or assumptionSetId on a reordered message', () => {
    noteIntentDeclared(OWNER, 202);
    noteAssumptionAsserted(OWNER, 909);
    applyReplicatedStamp({ ownerId: OWNER, at: Date.now(), patch: { intentEventId: 101 } });
    applyReplicatedStamp({ ownerId: OWNER, at: Date.now(), patch: { assumptionSetId: 808 } });
    expect(readAgentStateStamp(OWNER)).toMatchObject({ intentEventId: 202, assumptionSetId: 909 });
  });

  it('advances them when the message is genuinely newer', () => {
    noteIntentDeclared(OWNER, 101);
    applyReplicatedStamp({ ownerId: OWNER, at: Date.now(), patch: { intentEventId: 303 } });
    expect(readAgentStateStamp(OWNER).intentEventId).toBe(303);
  });

  it('drops a goal write older than the one already applied', () => {
    const t = Date.now();
    applyReplicatedStamp({ ownerId: OWNER, at: t, patch: { goalRef: 'WI-6502' } });
    applyReplicatedStamp({ ownerId: OWNER, at: t - 5_000, patch: { goalRef: 'WI-1111' } });
    expect(readAgentStateStamp(OWNER).goalRef).toBe('WI-6502');
  });

  it('normalises a replicated goal ref through asGoalRef', () => {
    applyReplicatedStamp({ ownerId: OWNER, at: Date.now(), patch: { goalRef: '  WI-6502  ' } });
    expect(readAgentStateStamp(OWNER).goalRef).toBe('WI-6502');
  });

  it('a replicated apply does not re-publish (the relay ring terminates)', () => {
    const published: AgentStampPatchEvent[] = [];
    setAgentStampPublisher((e) => published.push(e));
    applyReplicatedStamp({ ownerId: OWNER, at: Date.now(), patch: { intentEventId: 101 } });
    expect(published).toHaveLength(0);
  });
});

describe('single-process behaviour is unchanged', () => {
  it('stamps without a publisher installed', () => {
    noteIntentDeclared(OWNER, 101);
    noteGoalClaimed(OWNER, 'WI-6502');
    expect(readAgentStateStamp(OWNER)).toEqual({
      intentEventId: 101,
      assumptionSetId: null,
      goalRef: 'WI-6502',
    });
  });

  it('a throwing publisher can never fail the declaring call', () => {
    setAgentStampPublisher(() => {
      throw new Error('IPC channel closed');
    });
    expect(() => noteGoalClaimed(OWNER, 'WI-6502')).not.toThrow();
    expect(readAgentStateStamp(OWNER).goalRef).toBe('WI-6502');
  });
});

describe('IPC transport', () => {
  it('rejects foreign traffic on the shared message channel', () => {
    expect(isAgentStampPatchMessage({ type: 'papercusp:cluster-heartbeat' })).toBe(false);
    expect(isAgentStampPatchMessage(null)).toBe(false);
    expect(isAgentStampPatchMessage({ type: AGENT_STAMP_PATCH_TYPE })).toBe(false);
    expect(
      isAgentStampPatchMessage({ type: AGENT_STAMP_PATCH_TYPE, event: { ownerId: '', at: 1, patch: {} } }),
    ).toBe(false);
    expect(
      isAgentStampPatchMessage({
        type: AGENT_STAMP_PATCH_TYPE,
        event: { ownerId: OWNER, at: 1, patch: { goalRef: 'WI-1' } },
      }),
    ).toBe(true);
  });

  it('publisher -> relay -> receiver carries a declaration end to end', () => {
    const sent: AgentStampPatchMessage[] = [];
    const pub = startWorkerStampPublisher({ send: (m) => sent.push(m) });
    noteGoalClaimed(OWNER, 'WI-6502');
    pub.stop();
    expect(sent).toHaveLength(1);

    // The primary relays it to every worker.
    const cluster = new EventEmitter() as unknown as Parameters<typeof startPrimaryStampRelay>[0]['cluster'];
    const broadcast: AgentStampPatchMessage[] = [];
    const relay = startPrimaryStampRelay({ cluster, broadcast: (m) => broadcast.push(m) });
    resetAgentStateStamps(); // now acting as the primary, which never saw the claim
    (cluster as unknown as EventEmitter).emit('message', {}, sent[0]);
    expect(readAgentStateStamp(OWNER).goalRef).toBe('WI-6502');
    expect(broadcast).toEqual(sent);
    relay.stop();

    // And a peer worker applies the broadcast.
    const bus = new EventEmitter();
    const rx = startWorkerStampReceiver({
      on: (e, cb) => void bus.on(e, cb),
      off: (e, cb) => void bus.off(e, cb),
    });
    resetAgentStateStamps();
    bus.emit('message', broadcast[0]);
    expect(readAgentStateStamp(OWNER).goalRef).toBe('WI-6502');
    rx.stop();
  });

  it('startWorkerStampPublisher is inert with no IPC channel', () => {
    const send = process.send;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).send = undefined;
    try {
      const h = startWorkerStampPublisher();
      noteGoalClaimed(OWNER, 'WI-6502');
      expect(readAgentStateStamp(OWNER).goalRef).toBe('WI-6502');
      h.stop();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process as any).send = send;
    }
  });
});
