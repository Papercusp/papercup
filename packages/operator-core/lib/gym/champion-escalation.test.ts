/**
 * champion-escalation.test.ts — pins the NOV-4 champion-escalation builder
 * (autonomous-loop-prod-audit-2026-07-02 P-016 / WI-4636).
 *
 * PURE tests: buildChampionEscalationInput does no I/O, so every invariant is
 * asserted without PG. escalateChampionToQueenFrontier is exercised with a fake writer.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildChampionEscalationInput,
  escalateChampionToQueenFrontier,
  type ChampionEscalationInput,
} from './champion-escalation';
import type { CaptureImprovementInput, CaptureImprovementResult } from '../harness/improvements/capture-core';

const base: ChampionEscalationInput = {
  proposalId: 'prop-abc123',
  harnessSlug: 'papercusp',
  role: 'scoper',
  cycle: 42,
  variantId: 'variant-9',
  devAnchorDelta: 0.12345,
  costDelta: -0.002,
  probeStatus: 'clean',
  createdBy: 'gym:accept',
};

function escalationMetaOf(input: CaptureImprovementInput): Record<string, unknown> {
  return (input.payloadExtra?.championEscalation ?? {}) as Record<string, unknown>;
}

describe('buildChampionEscalationInput — capture shape', () => {
  it('files into the DEFAULT improvement lane (the Queen ordinary triage backlog), forced, human-gated', () => {
    const out = buildChampionEscalationInput(base);
    expect(out.lane).toBe('improvement');
    expect(out.kind).toBe('change');
    expect(out.force).toBe(true);
    expect(out.severity).toBe('nit');
    expect(out.sourceRole).toBe('system');
    expect(out.scope).toBe('harness:papercusp');
    expect(out.createdBy).toBe('gym:accept');
  });

  it('carries the stable per-(harness, role) watchdogKey so a re-promotion COALESCES instead of filing a sibling (WI-39594)', () => {
    const out = buildChampionEscalationInput(base);
    // NOT per-cycle: the queue audit of 2026-08-17 dropped ~25 open one-per-cycle
    // champion items. One open escalation per role@harness; cycles ride occurrences.
    expect(out.watchdogKey).toBe('gym-champion:papercusp:scoper');
    const nextCycle = buildChampionEscalationInput({ ...base, cycle: 43 });
    expect(nextCycle.watchdogKey).toBe(out.watchdogKey);
  });

  it('title names the role, harness, and cycle', () => {
    const out = buildChampionEscalationInput(base);
    expect(out.title).toContain('scoper@papercusp');
    expect(out.title).toContain('cycle 42');
  });

  it('omits the cycle segment when cycle is absent', () => {
    const out = buildChampionEscalationInput({ ...base, cycle: undefined });
    expect(out.title).not.toContain('cycle');
  });

  it('body carries the proposal ref, variant, and both deltas', () => {
    const out = buildChampionEscalationInput(base);
    const body = out.body ?? '';
    expect(body).toContain('gym:proposal-prop-abc123');
    expect(body).toContain('variant-9');
    expect(body).toContain('+0.123');
    expect(body).toContain('-0.002');
    expect(body).toContain('clean');
  });

  it('renders unmeasured deltas explicitly rather than silently omitting them', () => {
    const out = buildChampionEscalationInput({
      ...base,
      devAnchorDelta: null,
      costDelta: undefined,
    });
    const body = out.body ?? '';
    expect(body).toMatch(/Dev-anchor delta: unmeasured/);
    expect(body).toMatch(/Cost delta: unmeasured/);
  });

  it('mirrors the structured fields onto payload.championEscalation for downstream consumers', () => {
    const meta = escalationMetaOf(buildChampionEscalationInput(base));
    expect(meta.kind).toBe('gym-champion-promoted');
    expect(meta.proposalId).toBe('prop-abc123');
    expect(meta.harnessSlug).toBe('papercusp');
    expect(meta.role).toBe('scoper');
    expect(meta.cycle).toBe(42);
    expect(meta.variantId).toBe('variant-9');
  });
});

describe('escalateChampionToQueenFrontier — writer edge', () => {
  it('hands the built input to the injected captureImprovement writer', async () => {
    const captured: CaptureImprovementInput[] = [];
    const fakeResult: CaptureImprovementResult = {
      ok: true,
      created: true,
      kind: 'change',
      possibleDuplicates: [],
    };
    const captureImprovement = vi.fn(async (input: CaptureImprovementInput) => {
      captured.push(input);
      return fakeResult;
    });
    const result = await escalateChampionToQueenFrontier(base, { captureImprovement });
    expect(result).toBe(fakeResult);
    expect(captured).toHaveLength(1);
    expect(captured[0].lane).toBe('improvement');
    expect(captured[0].title).toContain('scoper@papercusp');
  });

  it("retries under the platform Pot when the harness scope is refused as 'pot_not_found' (P-005 vs gym throwaway harnesses)", async () => {
    const captured: CaptureImprovementInput[] = [];
    const fakeResult: CaptureImprovementResult = {
      ok: true,
      created: true,
      kind: 'change',
      possibleDuplicates: [],
    };
    const potErr = Object.assign(new Error("pot 'gymloopharness' is not a real Pot in workspace 'papercusp-workspace'"), {
      code: 'pot_not_found',
    });
    const captureImprovement = vi.fn(async (input: CaptureImprovementInput) => {
      if (input.scope !== undefined) throw potErr;
      captured.push(input);
      return fakeResult;
    });
    const result = await escalateChampionToQueenFrontier(base, { captureImprovement });
    expect(result).toBe(fakeResult);
    expect(captureImprovement).toHaveBeenCalledTimes(2);
    // The retry drops ONLY the scope (→ platform Pot); the harness identity survives in
    // the title/body/payload so the champion signal stays fully attributable.
    expect(captured).toHaveLength(1);
    expect(captured[0].scope).toBeUndefined();
    expect(captured[0].title).toContain('scoper@papercusp');
    expect((captured[0].payloadExtra as { championEscalation: { harnessSlug: string } }).championEscalation.harnessSlug).toBe('papercusp');
  });

  it('does NOT retry on a non-pot failure (the writer error propagates)', async () => {
    const boom = new Error('pg down');
    const captureImprovement = vi.fn(async () => {
      throw boom;
    });
    await expect(escalateChampionToQueenFrontier(base, { captureImprovement })).rejects.toBe(boom);
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });
});
