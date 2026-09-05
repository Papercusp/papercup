import { describe, expect, it } from 'vitest';
import {
  releaseFixerNoTurnEscalationBody,
  isReleaseFixerNoTurnFailure,
  isRetryableReleaseFixerNoTurnFailure,
} from './fixer-liveness';

describe('release-fixer no-turn escalation', () => {
  it('renders a bounded, actionable escalation body from the existing escalation surface', () => {
    const body = JSON.parse(
      releaseFixerNoTurnEscalationBody({
        installSlug: 'papercusp',
        workspaceId: 'papercusp-workspace',
        spawnId: 's-1786521677461-f0253d92',
        candidate: 'deadbeefcafe0123',
        failingTests: Array.from({ length: 25 }, (_, i) => `test-${i}`),
        errorMessage: 'infra_loss: papercusp/release-fixer timed out before producing a turn',
        nowMs: 1_800_000_000_000,
      }),
    );
    expect(body.kind).toBe('release-fixer-no-turn');
    expect(body.harness_slug).toBe('papercusp');
    expect(body.workspace_id).toBe('papercusp-workspace');
    expect(body.spawnId).toBe('s-1786521677461-f0253d92');
    expect(body.candidate).toBe('deadbeefcafe');
    expect(body.failingTests).toHaveLength(20);
    expect(body.timedOut).toBe(true);
    expect(body.emitted_at).toBe(1_800_000_000_000);
    expect(body.detail).toContain('did not provide a diagnosis');
    expect(body.detail).toContain('account/gateway telemetry');
  });

  it('recognizes both generic and timeout-specific no-turn diagnostics', () => {
    expect(isReleaseFixerNoTurnFailure('infra_loss: produced no turn (timedOut=false)')).toBe(true);
    expect(isReleaseFixerNoTurnFailure('context_overflow: before it produced a turn')).toBe(true);
    expect(isReleaseFixerNoTurnFailure('auth_error: before the agent produced a turn')).toBe(true);
    expect(isReleaseFixerNoTurnFailure('invoke HTTP 503')).toBe(false);
  });

  it('retries only infra_loss no-turns, not capacity or other terminal launch failures', () => {
    expect(isRetryableReleaseFixerNoTurnFailure('infra_loss: produced no turn (timedOut=false)')).toBe(true);
    expect(isRetryableReleaseFixerNoTurnFailure('infra_loss: timed out before producing a turn')).toBe(true);
    expect(isRetryableReleaseFixerNoTurnFailure('capacity_shed: produced no turn')).toBe(false);
    expect(isRetryableReleaseFixerNoTurnFailure('auth_error: before the agent produced a turn')).toBe(false);
    expect(isRetryableReleaseFixerNoTurnFailure('context_overflow: before it produced a turn')).toBe(false);
    expect(isRetryableReleaseFixerNoTurnFailure('produced no turn without a failure class')).toBe(false);
  });
});
