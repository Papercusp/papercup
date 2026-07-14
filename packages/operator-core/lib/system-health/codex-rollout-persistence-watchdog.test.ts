import { describe, expect, it } from 'vitest';
import {
  evaluateCodexRolloutPersistence,
  type CodexRolloutPersistenceSnapshot,
} from './codex-rollout-persistence-watchdog';

const NOW = 1_000_000;
const base: CodexRolloutPersistenceSnapshot = {
  sessionId: '11801',
  ownerId: 'su-owner',
  pidAlive: true,
  historyMtimeMs: NOW - 60_000,
  rolloutMtimeMs: NOW - 60_000,
};

describe('evaluateCodexRolloutPersistence', () => {
  it('alarms when a live Codex process has fresh history but no rollout file', () => {
    const verdict = evaluateCodexRolloutPersistence({ ...base, rolloutMtimeMs: null }, NOW);
    expect(verdict.stalled).toBe(true);
    expect(verdict.reason).toContain('no rollout JSONL exists');
  });

  it('alarms when history is fresh but the rollout falls behind the lag ceiling', () => {
    const verdict = evaluateCodexRolloutPersistence(
      { ...base, rolloutMtimeMs: NOW - 17 * 60_000 },
      NOW,
    );
    expect(verdict.stalled).toBe(true);
    expect(verdict.reason).toContain('behind history.jsonl');
  });

  it('does not alarm for an idle session, a dead process, or a fresh rollout', () => {
    expect(evaluateCodexRolloutPersistence({ ...base, historyMtimeMs: NOW - 6 * 60_000 }, NOW).stalled).toBe(false);
    expect(evaluateCodexRolloutPersistence({ ...base, pidAlive: false, rolloutMtimeMs: null }, NOW).stalled).toBe(false);
    expect(evaluateCodexRolloutPersistence({ ...base, rolloutMtimeMs: NOW - 2 * 60_000 }, NOW).stalled).toBe(false);
  });
});
