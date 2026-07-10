/**
 * operator-sentinel-handoff-deps.test.ts — WI-2200 (EI-3643): the real-substrate
 * `surfaceForApproval` dep must pin a STABLE dedup identity on the escalation it
 * opens, so a re-proposal of the SAME (capability, harness) gate — worded
 * differently each turn by the Sentinel's own restatement — bumps the existing
 * open escalation (openEscalation's built-in dedup) instead of minting a fresh
 * duplicate. Live evidence: 34 open, never-resolved, differently-worded
 * escalations for capability=cup:spawn/fleet:spawn harness=workspace before this
 * fix — openEscalation's default subjectSignature falls back to the raw summary
 * text, and the summary is NEVER the same twice.
 *
 * Mocks the `escalations` module's openEscalation (the only real substrate call
 * this dep makes) so the test asserts the exact args without touching PG.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const openEscalationSpy = vi.fn(async (_identity: unknown, input: unknown) => ({ ...(input as object), msg_id: 'esc-1' }));
const refreshCandidatesSpy = vi.fn(async () => {});

vi.mock('./agent-tools/coordination/escalations', () => ({
  openEscalation: (...args: unknown[]) => openEscalationSpy(...(args as [unknown, unknown])),
}));
vi.mock('./operator-standing-candidates', () => ({
  refreshCandidates: () => refreshCandidatesSpy(),
}));
// `surfaceForApproval` lazy-imports `./delegated-tasks` ONLY for the
// OPERATOR_COORD_OWNER const — but the real module pulls in the heavy PG chain
// (@papercusp/db-org → ./work-items → ./issues-engineer), whose one-time cold
// transform (~26s here) exceeds the 60s per-test timeout under the loaded
// green-checkpoint box. That timeout then leaks the pending openEscalation call
// into the NEXT test (the "expected 2, got 3" symptom). Mock it so the test
// stays hermetic and fast, matching this file's "without touching PG" intent.
vi.mock('./delegated-tasks', () => ({
  OPERATOR_COORD_OWNER: 'operator',
}));

import { defaultSentinelHandoffDeps } from './operator-sentinel-handoff-deps';

describe('defaultSentinelHandoffDeps().surfaceForApproval — WI-2200 stable dedup identity', () => {
  beforeEach(() => {
    openEscalationSpy.mockClear();
    refreshCandidatesSpy.mockClear();
  });

  it('pins meta.dedupKind + subjectSignature to the (capability, harness) pair, NOT the free-text summary', async () => {
    const deps = defaultSentinelHandoffDeps();
    await deps.surfaceForApproval({
      summary: 'overhaul user onboarding flow end to end across the three harnesses currently owning it',
      tier: 'high',
      capability: 'cup:spawn',
      harness: 'workspace',
    });
    expect(openEscalationSpy).toHaveBeenCalledTimes(1);
    const [, input] = openEscalationSpy.mock.calls[0]!;
    expect((input as { meta: { dedupKind: string; subjectSignature: string } }).meta).toEqual({
      dedupKind: 'sentinel-handoff-approval',
      subjectSignature: 'cup:spawn:workspace',
    });
  });

  it('a DIFFERENTLY-WORDED re-proposal for the SAME (capability, harness) produces the SAME dedup identity', async () => {
    const deps = defaultSentinelHandoffDeps();
    await deps.surfaceForApproval({ summary: 'Add a CSV export button to the runs table', tier: 'high', capability: 'cup:spawn', harness: 'workspace' });
    await deps.surfaceForApproval({ summary: 'plan and ship the new export feature EXP-2847', tier: 'high', capability: 'cup:spawn', harness: 'workspace' });
    expect(openEscalationSpy).toHaveBeenCalledTimes(2);
    const sig1 = (openEscalationSpy.mock.calls[0]![1] as { meta: { subjectSignature: string } }).meta.subjectSignature;
    const sig2 = (openEscalationSpy.mock.calls[1]![1] as { meta: { subjectSignature: string } }).meta.subjectSignature;
    // Identical dedup identity despite completely different summaries — this is what
    // lets openEscalation's own findOpenDuplicate/tryBumpProjectionDuplicate collapse
    // them into one bumped-repeatCount escalation instead of two open duplicates.
    expect(sig1).toBe(sig2);
    expect(sig1).toBe('cup:spawn:workspace');
  });

  it('a DIFFERENT harness produces a DISTINCT subjectSignature (never over-collapses unrelated gates)', async () => {
    const deps = defaultSentinelHandoffDeps();
    await deps.surfaceForApproval({ summary: 'x', tier: 'high', capability: 'cup:spawn', harness: 'workspace' });
    await deps.surfaceForApproval({ summary: 'y', tier: 'high', capability: 'cup:spawn', harness: 'analytics-core' });
    const sig1 = (openEscalationSpy.mock.calls[0]![1] as { meta: { subjectSignature: string } }).meta.subjectSignature;
    const sig2 = (openEscalationSpy.mock.calls[1]![1] as { meta: { subjectSignature: string } }).meta.subjectSignature;
    expect(sig1).not.toBe(sig2);
  });

  it('a null harness falls back to the "workspace" label (matches the escalation body text)', async () => {
    const deps = defaultSentinelHandoffDeps();
    await deps.surfaceForApproval({ summary: 'x', tier: 'medium', capability: 'cup:spawn', harness: null });
    const input = openEscalationSpy.mock.calls[0]![1] as { meta: { subjectSignature: string }; body: string };
    expect(input.meta.subjectSignature).toBe('cup:spawn:workspace');
    expect(input.body).toContain('harness=workspace');
  });

  it('still refreshes standing-approval candidates after opening the escalation', async () => {
    const deps = defaultSentinelHandoffDeps();
    await deps.surfaceForApproval({ summary: 'x', tier: 'high', capability: 'cup:spawn', harness: 'workspace' });
    expect(refreshCandidatesSpy).toHaveBeenCalledTimes(1);
  });
});
