import { describe, expect, it, vi } from 'vitest';
import { compileAgentSpecification } from '@papercusp/orchestrator/blueprint';

import {
  UNAPPLIED_ACTIVATION_TURN_THRESHOLD,
  classifyCandidate,
  classifyUnapplied,
  runUnappliedActivationCensusOnce,
  runWedgedIdentitySweepOnce,
  type CandidateRow,
  type UnappliedActivationCensusDeps,
  type UnappliedCandidateRow,
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
    verdictCache: { verdicts: new Map(), lastReused: 0, lastScanned: 0 },
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

// WI-10004803: the default loader streams cursor pages instead of one 1.5 GB result.
describe('runWedgedIdentitySweepOnce — paged candidates', () => {
  async function* pages(...batches: Array<CandidateRow[] | Error>): AsyncGenerator<CandidateRow[]> {
    for (const batch of batches) {
      if (batch instanceof Error) throw batch;
      yield batch;
    }
  }

  it('classifies every page and counts rows across pages', async () => {
    const escalateWedged = vi.fn(async () => {});
    const out = await runWedgedIdentitySweepOnce(deps({
      loadCandidates: () => pages([row()], [], [row({ ownerId: 'su-wedged', launchSpec: {} }), row()]),
      escalateWedged,
    }));
    expect(out).toMatchObject({
      verdict: 'wedged',
      scanned: 3,
      wedged: [{ ownerId: 'su-wedged', reason: 'receipt-missing', liveness: 'live' }],
    });
  });

  it('a page that fails mid-stream fails the sweep closed, even after a wedge was found', async () => {
    const escalateWedged = vi.fn(async () => {});
    const escalateNotMeasured = vi.fn(async () => {});
    const out = await runWedgedIdentitySweepOnce(deps({
      loadCandidates: () => pages([row({ ownerId: 'su-wedged', launchSpec: {} })], new Error('cursor reset')),
      escalateWedged,
      escalateNotMeasured,
    }));
    expect(out).toEqual({ verdict: 'not-measured', reason: 'candidate read failed: cursor reset', escalated: 1 });
    expect(escalateNotMeasured).toHaveBeenCalledTimes(1);
    expect(escalateWedged).not.toHaveBeenCalled();
  });

  it('a stream of only empty pages is not-measured, never clean', async () => {
    const out = await runWedgedIdentitySweepOnce(deps({ loadCandidates: () => pages([], []) }));
    expect(out).toMatchObject({ verdict: 'not-measured', escalated: 1 });
  });
});

// ── WI-10005391: verdicts carried across sweeps ───────────────────────────

describe('runWedgedIdentitySweepOnce — carried verdicts (WI-10005391)', () => {
  type Cache = WedgedIdentitySweepDeps['verdictCache'];
  const freshCache = (): Cache => ({ verdicts: new Map(), lastReused: 0, lastScanned: 0 });

  /**
   * Behaves like the SQL loader: a row whose key the sweep already holds comes
   * back WITHOUT its launch record. If such a row were ever classified instead
   * of reused, `launchSpec: undefined` would read as a malformed launch record
   * and flag a healthy session — so a clean verdict below proves the reuse.
   */
  function omittingLoader(rows: CandidateRow[], seen: Array<readonly string[]> = []) {
    return (known: readonly string[]) => {
      seen.push(known);
      return Promise.resolve(rows.map((r) =>
        r.verdictKey && known.includes(r.verdictKey)
          ? { ...r, launchSpec: undefined, launchSpecOmitted: true }
          : r,
      ));
    };
  }

  it('reuses a carried verdict for an unchanged row instead of classifying it', async () => {
    const verdictCache = freshCache();
    const rows = [row({ verdictKey: '1:100:a' })];
    const seen: Array<readonly string[]> = [];

    const first = await runWedgedIdentitySweepOnce(deps({ verdictCache, loadCandidates: omittingLoader(rows, seen) }));
    expect(first).toEqual({ verdict: 'clean', scanned: 1, escalated: 0 });
    expect(verdictCache).toMatchObject({ lastReused: 0, lastScanned: 1 });

    const second = await runWedgedIdentitySweepOnce(deps({ verdictCache, loadCandidates: omittingLoader(rows, seen) }));
    expect(second).toEqual({ verdict: 'clean', scanned: 1, escalated: 0 });
    expect(verdictCache).toMatchObject({ lastReused: 1, lastScanned: 1 });
    expect(seen).toEqual([[], ['1:100:a']]);
  });

  it('keeps reporting a carried WEDGED verdict on every sweep', async () => {
    const verdictCache = freshCache();
    const rows = [row({ ownerId: 'su-wedged', launchSpec: {}, verdictKey: '2:7:b' })];
    await runWedgedIdentitySweepOnce(deps({ verdictCache, loadCandidates: omittingLoader(rows) }));
    const again = await runWedgedIdentitySweepOnce(deps({ verdictCache, loadCandidates: omittingLoader(rows) }));
    expect(again).toMatchObject({
      verdict: 'wedged',
      wedged: [{ ownerId: 'su-wedged', reason: 'receipt-missing', liveness: 'live' }],
    });
    expect(verdictCache.lastReused).toBe(1);
  });

  it('re-classifies a row whose key changed (a new launch row version or activation)', async () => {
    const verdictCache = freshCache();
    await runWedgedIdentitySweepOnce(deps({ verdictCache, loadCandidates: omittingLoader([row({ verdictKey: '3:1:c' })]) }));
    const changed = await runWedgedIdentitySweepOnce(deps({
      verdictCache,
      loadCandidates: omittingLoader([row({ ownerId: 'su-wedged', launchSpec: {}, verdictKey: '3:2:c' })]),
    }));
    expect(changed).toMatchObject({ verdict: 'wedged', wedged: [{ ownerId: 'su-wedged', reason: 'receipt-missing' }] });
    expect([...verdictCache.verdicts.keys()]).toEqual(['3:2:c']);
  });

  it('fails closed when the loader omits a launch record the sweep holds no verdict for', async () => {
    const escalateNotMeasured = vi.fn(async () => {});
    const out = await runWedgedIdentitySweepOnce(deps({
      escalateNotMeasured,
      loadCandidates: async () => [row({ launchSpec: undefined, launchSpecOmitted: true, verdictKey: '9:9:z' })],
    }));
    expect(out).toMatchObject({ verdict: 'not-measured', escalated: 1 });
    expect(escalateNotMeasured).toHaveBeenCalledTimes(1);
  });

  it('a failed scan leaves the carried verdicts intact; a complete scan drops rows it no longer sees', async () => {
    const verdictCache = freshCache();
    await runWedgedIdentitySweepOnce(deps({
      verdictCache,
      loadCandidates: omittingLoader([row({ verdictKey: '4:1:d' }), row({ ownerId: 'su-gone', verdictKey: '5:1:e' })]),
    }));
    expect(verdictCache.verdicts.size).toBe(2);

    await runWedgedIdentitySweepOnce(deps({ verdictCache, loadCandidates: async () => { throw new Error('cursor reset'); } }));
    expect(verdictCache.verdicts.size).toBe(2);

    await runWedgedIdentitySweepOnce(deps({ verdictCache, loadCandidates: omittingLoader([row({ verdictKey: '4:1:d' })]) }));
    expect([...verdictCache.verdicts.keys()]).toEqual(['4:1:d']);
  });
});

// ── WI-10004999: the unapplied-activation census ──────────────────────────

type Pair = { specificationRevision: string; stateRevision: string };

/** A persisted activation envelope with an explicit prepared slot. */
function censusActivation(input: {
  status: 'desired' | 'prepared' | 'applied';
  desired: Pair;
  applied?: Pair | null;
}) {
  return {
    schemaVersion: 1,
    attribution: ATTRIBUTION,
    desired: input.desired,
    prepared: input.status === 'prepared' ? input.desired : null,
    applied: input.status === 'applied' ? input.desired : (input.applied ?? null),
    status: input.status,
  };
}

// The activation normalizer requires a lowercase sha256 specificationRevision.
const SPEC_NEW = 'a'.repeat(64);
const SPEC_OLD = 'b'.repeat(64);
const NEW: Pair = { specificationRevision: SPEC_NEW, stateRevision: 'state-new' };
const OLD: Pair = { specificationRevision: SPEC_OLD, stateRevision: 'state-old' };

function censusRow(overrides: Partial<UnappliedCandidateRow> = {}): UnappliedCandidateRow {
  return {
    ownerId: 'su-stuck',
    activation: censusActivation({ status: 'prepared', desired: NEW, applied: null }),
    unappliedSince: '2026-10-01T17:47:00.000Z',
    turnsSince: UNAPPLIED_ACTIVATION_TURN_THRESHOLD,
    ...overrides,
  };
}

function censusDeps(overrides: Partial<UnappliedActivationCensusDeps> = {}): UnappliedActivationCensusDeps {
  return {
    loadUnapplied: async () => [censusRow()],
    loadPositiveControl: async () => ({ recentBriefs: 90, recentJournalTurns: 3409 }),
    resolveLiveness: async (ids) => new Map(ids.map((id) => [id, 'live' as WedgedLiveness])),
    escalateUnapplied: vi.fn(async () => {}),
    escalateNotMeasured: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('classifyUnapplied — turns gate the finding, not the status label alone', () => {
  it('flags a launch that stayed prepared through the threshold of completed turns (WI-10004663 class)', () => {
    expect(classifyUnapplied(censusRow())).toEqual({
      unapplied: true,
      status: 'prepared',
      turnsSince: UNAPPLIED_ACTIVATION_TURN_THRESHOLD,
      unappliedSince: '2026-10-01T17:47:00.000Z',
    });
  });

  it('does NOT flag a session still inside the legitimate window (applies at the next turn start)', () => {
    for (let turns = 0; turns < UNAPPLIED_ACTIVATION_TURN_THRESHOLD; turns += 1) {
      expect(classifyUnapplied(censusRow({ turnsSince: turns }))).toEqual({ unapplied: false });
    }
  });

  it('does NOT flag an applied activation however many turns it has taken', () => {
    const row = censusRow({ activation: censusActivation({ status: 'applied', desired: NEW }), turnsSince: 10 });
    expect(classifyUnapplied(row)).toEqual({ unapplied: false });
  });

  it('does NOT flag a re-desire of the identity that is already applied (span already open)', () => {
    const row = censusRow({
      activation: censusActivation({ status: 'desired', desired: NEW, applied: NEW }),
      turnsSince: 10,
    });
    expect(classifyUnapplied(row)).toEqual({ unapplied: false });
  });

  it('flags a same-spec, different-state transition left prepared (measured: su-d5eaa301, 2026-10-01)', () => {
    const row = censusRow({
      activation: censusActivation({
        status: 'prepared',
        desired: { specificationRevision: SPEC_OLD, stateRevision: 'c'.repeat(64) },
        applied: OLD,
      }),
      turnsSince: 3,
    });
    expect(classifyUnapplied(row)).toMatchObject({ unapplied: true, status: 'prepared', turnsSince: 3 });
  });

  it('flags a desired transition that never reached prepared once it has taken the threshold of turns', () => {
    const row = censusRow({ activation: censusActivation({ status: 'desired', desired: NEW, applied: OLD }) });
    expect(classifyUnapplied(row)).toMatchObject({ unapplied: true, status: 'desired' });
  });

  it('reports an unapplied row with no activation event as UNMEASURED, never as a finding or as clean', () => {
    expect(classifyUnapplied(censusRow({ unappliedSince: null, turnsSince: 0 }))).toEqual({ unapplied: 'unmeasured' });
  });

  it('treats a malformed activation as ungoverned, matching the kernel', () => {
    expect(classifyUnapplied(censusRow({ activation: { status: 'prepared' } }))).toEqual({ unapplied: false });
  });
});

describe('runUnappliedActivationCensusOnce — fail-closed', () => {
  it('escalates NOT MEASURED when the census read throws', async () => {
    const escalateNotMeasured = vi.fn(async () => {});
    const escalateUnapplied = vi.fn(async () => {});
    const out = await runUnappliedActivationCensusOnce(censusDeps({
      loadUnapplied: async () => {
        throw new Error('relation does not exist');
      },
      escalateNotMeasured,
      escalateUnapplied,
    }));
    expect(out).toEqual({ verdict: 'not-measured', reason: 'census read failed: relation does not exist', escalated: 1 });
    expect(escalateNotMeasured).toHaveBeenCalledTimes(1);
    expect(escalateUnapplied).not.toHaveBeenCalled();
  });

  it('escalates NOT MEASURED when an active fleet journaled zero turns — the turn counter is broken', async () => {
    const escalateNotMeasured = vi.fn(async () => {});
    const out = await runUnappliedActivationCensusOnce(censusDeps({
      // No candidates at all: without the control this would read clean.
      loadUnapplied: async () => [],
      loadPositiveControl: async () => ({ recentBriefs: 12, recentJournalTurns: 0 }),
      escalateNotMeasured,
    }));
    expect(out).toMatchObject({ verdict: 'not-measured', escalated: 1 });
    expect(escalateNotMeasured).toHaveBeenCalledTimes(1);
  });

  it('an idle box (no active briefs, no journal) is clean, not a broken instrument', async () => {
    const escalateNotMeasured = vi.fn(async () => {});
    const out = await runUnappliedActivationCensusOnce(censusDeps({
      loadUnapplied: async () => [],
      loadPositiveControl: async () => ({ recentBriefs: 0, recentJournalTurns: 0 }),
      escalateNotMeasured,
    }));
    expect(out).toEqual({ verdict: 'clean', scanned: 0, ended: 0, unmeasured: 0, escalated: 0 });
    expect(escalateNotMeasured).not.toHaveBeenCalled();
  });

  it('reports a confirmed finding with liveness unknown when the liveness read throws', async () => {
    const out = await runUnappliedActivationCensusOnce(censusDeps({
      resolveLiveness: async () => {
        throw new Error('presence down');
      },
    }));
    expect(out).toMatchObject({ verdict: 'unapplied', unapplied: [{ ownerId: 'su-stuck', liveness: 'unknown' }] });
  });
});

describe('runUnappliedActivationCensusOnce — verdicts', () => {
  it('escalates a live stuck session with its status, turns and since', async () => {
    const escalateUnapplied = vi.fn(async () => {});
    const out = await runUnappliedActivationCensusOnce(censusDeps({ escalateUnapplied }));
    const expected = [{
      ownerId: 'su-stuck',
      status: 'prepared',
      turnsSince: UNAPPLIED_ACTIVATION_TURN_THRESHOLD,
      unappliedSince: '2026-10-01T17:47:00.000Z',
      liveness: 'live',
    }];
    expect(out).toEqual({ verdict: 'unapplied', scanned: 1, unapplied: expected, ended: 0, unmeasured: 0, escalated: 1 });
    expect(escalateUnapplied).toHaveBeenCalledWith(expected);
  });

  it('does not alarm on an ended session, but counts it', async () => {
    const escalateUnapplied = vi.fn(async () => {});
    const out = await runUnappliedActivationCensusOnce(censusDeps({
      resolveLiveness: async (ids) => new Map(ids.map((id) => [id, 'ended' as WedgedLiveness])),
      escalateUnapplied,
    }));
    expect(out).toEqual({ verdict: 'clean', scanned: 1, ended: 1, unmeasured: 0, escalated: 0 });
    expect(escalateUnapplied).not.toHaveBeenCalled();
  });

  it('is clean when every unapplied session is still inside its window, and never resolves liveness', async () => {
    const resolveLiveness = vi.fn(async () => new Map<string, WedgedLiveness>());
    const out = await runUnappliedActivationCensusOnce(censusDeps({
      loadUnapplied: async () => [censusRow({ turnsSince: 0 }), censusRow({ ownerId: 'su-b', turnsSince: 1 })],
      resolveLiveness,
    }));
    expect(out).toEqual({ verdict: 'clean', scanned: 2, ended: 0, unmeasured: 0, escalated: 0 });
    expect(resolveLiveness).not.toHaveBeenCalled();
  });

  it('counts unmeasured rows without letting them hide a real finding', async () => {
    const out = await runUnappliedActivationCensusOnce(censusDeps({
      loadUnapplied: async () => [censusRow({ ownerId: 'su-noevent', unappliedSince: null, turnsSince: 0 }), censusRow()],
    }));
    expect(out).toMatchObject({ verdict: 'unapplied', unmeasured: 1, unapplied: [{ ownerId: 'su-stuck' }] });
  });
});
