import { beforeEach, describe, expect, it } from 'vitest';

import {
  DOOR_POLL_TURN_THRESHOLD,
  DOOR_VALUE_FRESH_MS,
  _resetBatchNudgeState,
  maybeStatePlaneNudge,
} from './code-run-batch-nudge';

const T0 = 1_700_000_000_000;
const S = 'sess-1';

/** Feed one call into the nudge plane and return whatever it wanted to say. */
function call(toolName: string, offsetMs: number, sessionKey = S, args?: unknown): string | null {
  return maybeStatePlaneNudge({ sessionKey, toolName, args, now: T0 + offsetMs });
}

beforeEach(() => {
  _resetBatchNudgeState();
});

describe('state-plane nudge — ACT/QUOTE rule', () => {
  it('fires on a durable write holding an un-re-read door value', () => {
    expect(call('dev:pipeline_position', 0)).toBeNull();
    const hint = call('coord:send', 5_000);
    expect(hint).toBeTruthy();
    expect(hint).toContain('state:read');
    expect(hint).toContain('dev:pipeline_position');
  });

  it('stays QUIET when the agent re-read the plane after the door call', () => {
    // The control for the test above: identical calls plus the re-read the rule asks for.
    expect(call('dev:pipeline_position', 0)).toBeNull();
    expect(call('state:read', 2_000)).toBeNull();
    expect(call('coord:send', 5_000)).toBeNull();
  });

  it('still fires when the state:read came BEFORE the door call (ordering is the rule)', () => {
    expect(call('state:read', 0)).toBeNull();
    expect(call('dev:pipeline_position', 2_000)).toBeNull();
    expect(call('coord:send', 5_000)).toBeTruthy();
  });

  it('stays quiet for a write with no door value in hand', () => {
    expect(call('coord:send', 0)).toBeNull();
  });

  it('stays quiet once the door value has gone stale', () => {
    expect(call('dev:pipeline_position', 0)).toBeNull();
    expect(call('coord:send', DOOR_VALUE_FRESH_MS + 1_000)).toBeNull();
  });

  it('stays quiet for a non-quote-sink tool', () => {
    expect(call('dev:pipeline_position', 0)).toBeNull();
    expect(call('capability:read', 1_000)).toBeNull();
  });

  it('is one-shot per session — it teaches, it does not hector', () => {
    expect(call('dev:pipeline_position', 0)).toBeNull();
    expect(call('coord:send', 1_000)).toBeTruthy();
    expect(call('dev:pipeline_position', 2_000)).toBeNull();
    expect(call('coord:send', 3_000)).toBeNull();
  });

  it('does not leak state across sessions', () => {
    expect(call('dev:pipeline_position', 0, 'sess-a')).toBeNull();
    expect(call('coord:send', 1_000, 'sess-b')).toBeNull();
  });

  it('recognises every declared quote sink', () => {
    for (const sink of [
      'coord:send',
      'plans:add-decision',
      'work_items:comment',
      'work_items:complete',
      'facts:assert',
      'plans:set-now',
    ]) {
      _resetBatchNudgeState();
      expect(call('dev:pipeline_position', 0)).toBeNull();
      expect(call(sink, 1_000), `${sink} should be treated as a quote sink`).toBeTruthy();
    }
  });
});

describe('state-plane nudge — WAIT/POLL rule', () => {
  it('fires once a door is read across the threshold of separate turns', () => {
    expect(call('dev:pipeline_position', 0)).toBeNull();
    expect(call('dev:pipeline_position', 60_000)).toBeNull();
    const hint = call('dev:pipeline_position', 120_000);
    expect(DOOR_POLL_TURN_THRESHOLD).toBe(3);
    expect(hint).toBeTruthy();
    expect(hint).toContain('state:subscribe');
  });

  it('does NOT count distinct pipeline source-containment probes as polling one predicate', () => {
    const probes = [
      { path: 'packages/operator-core/lib/dao-hr/native.e2e.test.ts', sourceRuntimeOnly: true },
      { path: 'packages/operator-core/lib/agent-tools/plans/with-plan-lock.ts',
        marker: 'synchronizeAcceptanceBarSubjectRevision', sourceRuntimeOnly: true },
      { path: 'packages/operator-core/lib/acceptance-bar-pin-reconcile.ts', sourceRuntimeOnly: true },
    ];
    for (const [index, args] of probes.entries()) {
      expect(call('dev:pipeline_position', index * 60_000, S, args)).toBeNull();
    }
  });

  it('still nudges when the same exact source-containment predicate repeats across turns', () => {
    const args = {
      path: 'packages/operator-core/lib/dao-hr/native.e2e.test.ts',
      expectedSourceSha256: 'a'.repeat(64),
      sourceRuntimeOnly: true,
    };
    expect(call('dev:pipeline_position', 0, S, args)).toBeNull();
    expect(call('dev:pipeline_position', 60_000, S, args)).toBeNull();
    expect(call('dev:pipeline_position', 120_000, S, args)).toContain('same dev:pipeline_position check');
  });

  it('does NOT treat calls batched into ONE turn as a poll loop', () => {
    // Calls dispatched from one response block cost a single round-trip. Nudging them
    // would punish exactly the batching behaviour the sibling nudge in this file asks for.
    expect(call('dev:pipeline_position', 0)).toBeNull();
    expect(call('dev:pipeline_position', 50)).toBeNull();
    expect(call('dev:pipeline_position', 100)).toBeNull();
    expect(call('dev:pipeline_position', 150)).toBeNull();
  });

  it('stays QUIET when the agent already subscribed — it made the right call', () => {
    expect(call('state:subscribe', 0)).toBeNull();
    expect(call('dev:pipeline_position', 10_000)).toBeNull();
    expect(call('dev:pipeline_position', 70_000)).toBeNull();
    expect(call('dev:pipeline_position', 130_000)).toBeNull();
  });

  it('is one-shot per session', () => {
    call('dev:pipeline_position', 0);
    call('dev:pipeline_position', 60_000);
    expect(call('dev:pipeline_position', 120_000)).toBeTruthy();
    expect(call('dev:pipeline_position', 180_000)).toBeNull();
  });
});
