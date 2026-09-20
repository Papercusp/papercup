import { describe, expect, it, vi } from 'vitest';
import { compileAgentSpecification } from '@papercusp/orchestrator/blueprint';

import {
  classifyCandidate,
  runWedgedIdentitySweepOnce,
  type CandidateRow,
  type WedgedIdentitySweepDeps,
  type WedgedLiveness,
} from './wedged-identity-activation-watchdog';

vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: vi.fn() }),
}));

const ATTRIBUTION = { actorId: 'su-a', principalId: 'system:superuser', sessionId: 'su-a' };

function spec(id: string, grants?: { requires?: string[] }) {
  return compileAgentSpecification({
    source: {
      id,
      workItem: { kind: 'feature' },
      spine: { edges: { DONE: { to: 'done' } } },
      ...(grants ? { grants } : {}),
    },
    prompt: { role: 'worker', text: `Prompt for ${id}.` },
    inputClosure: [],
  });
}

/** The persisted `control_state->'activation'` envelope, as the sweep reads it. */
function activation(input: {
  status: 'desired' | 'prepared' | 'applied' | 'failed';
  appliedRevision?: string | null;
  desiredRevision: string;
  stateRevision?: string;
}) {
  const stateRevision = input.stateRevision ?? 'state-a';
  return {
    schemaVersion: 1,
    attribution: ATTRIBUTION,
    desired: { specificationRevision: input.desiredRevision, stateRevision },
    prepared: null,
    applied: input.appliedRevision
      ? { specificationRevision: input.appliedRevision, stateRevision }
      : null,
    status: input.status,
    ...(input.status === 'failed' ? { failure: 'boom' } : {}),
  };
}

function row(overrides: Partial<CandidateRow> = {}): CandidateRow {
  const artifact = spec('healthy');
  return {
    ownerId: 'su-healthy',
    advSessionId: '1',
    launchSpec: {
      workspaceId: 'ws-a',
      harnessSlug: 'papercusp',
      specificationRevision: artifact.specificationRevision,
      stateRevision: 'state-a',
      specificationArtifact: artifact,
    },
    activation: activation({
      status: 'applied',
      appliedRevision: artifact.specificationRevision,
      desiredRevision: artifact.specificationRevision,
    }),
    ...overrides,
  };
}

function deps(overrides: Partial<WedgedIdentitySweepDeps> = {}): WedgedIdentitySweepDeps {
  return {
    loadCandidates: async () => [row()],
    resolveLiveness: async (ids) => new Map(ids.map((id) => [id, 'live' as WedgedLiveness])),
    escalateWedged: vi.fn(async () => {}),
    escalateNotMeasured: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('classifyCandidate — the two measured regressions', () => {
  // WI-10002060 regression 1. The originally-proposed predicate was
  // `activation->>'status' IS DISTINCT FROM 'applied'`, which selected 11 of 73
  // live sessions, ALL healthy. The status label is not the oracle: a converged
  // session legitimately carries prepared:null, and a session can sit at a
  // non-'applied' status while the gate admits every tool.
  it('does NOT flag a session whose status is not "applied" but whose receipt reconciles', () => {
    const artifact = spec('healthy');
    const candidate = row({
      activation: activation({
        status: 'desired',
        appliedRevision: artifact.specificationRevision,
        desiredRevision: artifact.specificationRevision,
      }),
    });
    expect(classifyCandidate(candidate)).toEqual({ wedged: false });
  });

  // WI-10002060 regression 2, the more dangerous half. The one genuinely wedged
  // session measured on 2026-09-20 (su-a961ddec…, corroborated by
  // EI-23498347945819811) carried status:'applied' — so the proposed predicate
  // did not merely over-report, it MISSED the real thing while reporting 11
  // false alarms. This is that exact shape: an acknowledged applied receipt
  // beside a launch record that carries no specificationRevision at all.
  it('DOES flag a session whose status is "applied" but whose launch record has no receipt', () => {
    const artifact = spec('healthy');
    const candidate = row({
      ownerId: 'su-wedged',
      launchSpec: { workspaceId: 'ws-a', harnessSlug: 'papercusp' },
      activation: activation({
        status: 'applied',
        appliedRevision: artifact.specificationRevision,
        desiredRevision: artifact.specificationRevision,
      }),
    });
    expect(classifyCandidate(candidate)).toEqual({ wedged: true, reason: 'receipt-missing' });
  });
});

describe('classifyCandidate — why a SQL paraphrase cannot replace the resolver', () => {
  // The single most important case. `launch_spec->>'specificationRevision'`
  // DIFFERS from `applied->>'specificationRevision'` here, so every jsonb
  // predicate proposed for this sweep calls it wedged. The gate does not: it
  // searches identityHistory for a matching receipt and finds one. Calling the
  // resolver is the only way to get this right.
  it('does NOT flag a revision mismatch that identityHistory reconciles', () => {
    const appliedSpec = spec('applied-one', { requires: [] });
    const currentSpec = spec('current-two', { requires: [] });
    expect(currentSpec.specificationRevision).not.toBe(appliedSpec.specificationRevision);

    const launchSpec = {
      workspaceId: 'ws-a',
      harnessSlug: 'papercusp',
      specificationRevision: currentSpec.specificationRevision,
      stateRevision: 'state-b',
      specificationArtifact: currentSpec,
      identityHistory: [{
        specificationRevision: appliedSpec.specificationRevision,
        stateRevision: 'state-a',
        specificationArtifact: appliedSpec,
      }],
    };
    const act = activation({
      status: 'applied',
      appliedRevision: appliedSpec.specificationRevision,
      desiredRevision: currentSpec.specificationRevision,
    });

    expect(classifyCandidate(row({ ownerId: 'su-history', launchSpec, activation: act })))
      .toEqual({ wedged: false });

    // DISCRIMINATING CONTROL — without this, the assertion above passes for the
    // wrong reason. `wedged:false` is also what an ungoverned specification
    // returns, so a fixture that simply carried no grants would look like a
    // successful identityHistory reconciliation. Drop ONLY the history entry and
    // the very same row must flip to wedged: that is what proves the history leg
    // is the thing doing the work, and that this test can fail at all.
    const withoutHistory = { ...launchSpec, identityHistory: [] };
    expect(classifyCandidate(row({ ownerId: 'su-history', launchSpec: withoutHistory, activation: act })))
      .toEqual({ wedged: true, reason: 'receipt-missing' });
  });

  it('flags a session with an acknowledged receipt but no launch row at all', () => {
    const artifact = spec('healthy');
    const candidate = row({
      ownerId: 'su-norecord',
      advSessionId: null,
      launchSpec: null,
      activation: activation({
        status: 'applied',
        appliedRevision: artifact.specificationRevision,
        desiredRevision: artifact.specificationRevision,
      }),
    });
    expect(classifyCandidate(candidate)).toEqual({ wedged: true, reason: 'no-launch-record' });
  });

  it('does NOT flag the legacy path — no acknowledged receipt means no identity governance', () => {
    const artifact = spec('healthy');
    const candidate = row({
      ownerId: 'su-legacy',
      launchSpec: { workspaceId: 'ws-a' },
      activation: activation({
        status: 'desired',
        appliedRevision: null,
        desiredRevision: artifact.specificationRevision,
      }),
    });
    expect(classifyCandidate(candidate)).toEqual({ wedged: false });
  });

  it('treats a malformed activation as ungoverned, matching the kernel', () => {
    const candidate = row({ ownerId: 'su-malformed', activation: { status: 'nonsense' } });
    expect(classifyCandidate(candidate)).toEqual({ wedged: false });
  });
});

describe('runWedgedIdentitySweepOnce — fail-closed', () => {
  it('escalates NOT MEASURED when the candidate read throws, and never returns clean', async () => {
    const escalateNotMeasured = vi.fn(async () => {});
    const escalateWedged = vi.fn(async () => {});
    const out = await runWedgedIdentitySweepOnce(deps({
      loadCandidates: async () => { throw new Error('relation does not exist'); },
      escalateNotMeasured,
      escalateWedged,
    }));
    expect(out.verdict).toBe('not-measured');
    expect(out.escalated).toBe(1);
    expect(escalateNotMeasured).toHaveBeenCalledTimes(1);
    expect(escalateWedged).not.toHaveBeenCalled();
  });

  // The built-in positive control. A query that matches nothing it should have
  // matched produces an empty wedged list, which is byte-identical to a clean
  // fleet — the exact way a sibling guard stayed silently inert for ~6 weeks.
  it('escalates NOT MEASURED when the scan sees zero rows', async () => {
    const escalateNotMeasured = vi.fn(async () => {});
    const out = await runWedgedIdentitySweepOnce(deps({
      loadCandidates: async () => [],
      escalateNotMeasured,
    }));
    expect(out.verdict).toBe('not-measured');
    expect(escalateNotMeasured).toHaveBeenCalledTimes(1);
  });

  it('reports a confirmed wedge even when the liveness read throws', async () => {
    const escalateWedged = vi.fn(async () => {});
    const out = await runWedgedIdentitySweepOnce(deps({
      loadCandidates: async () => [row({ ownerId: 'su-wedged', launchSpec: {} })],
      resolveLiveness: async () => { throw new Error('presence unavailable'); },
      escalateWedged,
    }));
    expect(out.verdict).toBe('wedged');
    expect(out).toMatchObject({ wedged: [{ ownerId: 'su-wedged', liveness: 'unknown' }] });
    expect(escalateWedged).toHaveBeenCalledTimes(1);
  });

  it('keeps a liveness-unknown wedge visible rather than dropping it', async () => {
    const out = await runWedgedIdentitySweepOnce(deps({
      loadCandidates: async () => [row({ ownerId: 'su-wedged', launchSpec: {} })],
      resolveLiveness: async () => new Map(),
    }));
    expect(out).toMatchObject({ verdict: 'wedged', wedged: [{ liveness: 'unknown' }] });
  });
});

describe('runWedgedIdentitySweepOnce — verdicts', () => {
  it('returns clean without escalating when every scanned session reconciles', async () => {
    const escalateWedged = vi.fn(async () => {});
    const escalateNotMeasured = vi.fn(async () => {});
    const out = await runWedgedIdentitySweepOnce(deps({ escalateWedged, escalateNotMeasured }));
    expect(out).toEqual({ verdict: 'clean', scanned: 1, escalated: 0 });
    expect(escalateWedged).not.toHaveBeenCalled();
    expect(escalateNotMeasured).not.toHaveBeenCalled();
  });

  it('does not alarm on a wedged session that has already ended', async () => {
    const escalateWedged = vi.fn(async () => {});
    const out = await runWedgedIdentitySweepOnce(deps({
      loadCandidates: async () => [row({ ownerId: 'su-dead', launchSpec: {} })],
      resolveLiveness: async (ids) => new Map(ids.map((id) => [id, 'ended' as WedgedLiveness])),
      escalateWedged,
    }));
    expect(out).toEqual({ verdict: 'clean', scanned: 1, escalated: 0 });
    expect(escalateWedged).not.toHaveBeenCalled();
  });

  it('escalates a live wedge and reports it with its reason', async () => {
    const escalateWedged = vi.fn(async () => {});
    const out = await runWedgedIdentitySweepOnce(deps({
      loadCandidates: async () => [row(), row({ ownerId: 'su-wedged', launchSpec: {} })],
      escalateWedged,
    }));
    expect(out).toMatchObject({
      verdict: 'wedged',
      scanned: 2,
      wedged: [{ ownerId: 'su-wedged', reason: 'receipt-missing', liveness: 'live' }],
    });
    expect(escalateWedged).toHaveBeenCalledTimes(1);
  });
});
