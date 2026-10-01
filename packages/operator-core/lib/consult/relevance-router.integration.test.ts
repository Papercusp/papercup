/**
 * relevance-router.integration.test.ts — routeConsult against a real Postgres
 * (pgvector), P-002 of get-feedback-relevance-consults-2026-08-16.
 *
 * Fixture geometry (same trick as sources.integration.test.ts): 384-d unit
 * vectors from a single direction angle, v(θ) = [cos θ, sin θ, 0, …], so the
 * cosine similarity between the query v(q) and a turn v(θ) is exactly
 * cos(q − θ) and the ranking is analytically checkable.
 *
 * What only a real-PG test can prove here:
 *  - the turn leg's SQL (workspace OR 'default', requester exclusion,
 *    machine-surface exclusion, vector ordering) against real pgvector;
 *  - the verification leg (completion_authority='committed', 90d window) and
 *    the authorship leg (payload->'paths' LATERAL match) against real jsonb;
 *  - the D-003 honesty invariants end-to-end: no_qualified_responder is a
 *    first-class verdict (far query), the HARD sim sub-floor blocks a
 *    high-track-record candidate even when its BLENDED score clears the floor,
 *    and a missing embedder degrades honestly while exposing only an explicit
 *    lexical fallback path (never semantic qualification).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config/pg';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { resolveProseProfileSelection } from '../search/prose-vector-dims';
import {
  routeConsult,
  extractPathTokens,
  DEFAULT_SIM_FLOOR,
  DEFAULT_RELEVANCE_FLOOR,
  type ConsultRouteDeps,
} from './relevance-router';

const WS = 'ws-consult';
const NOW = new Date('2026-08-16T00:00:00Z');
const DAY = 86_400_000;

/** 768-d unit vector at angle θ in the (0,1) plane. */
const vecAt = (theta: number): number[] => {
  const v = new Array<number>(768).fill(0);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
};

let rootSql: Sql;

const deps = (embedTheta: number | null, over: Partial<ConsultRouteDeps> = {}): ConsultRouteDeps => ({
  getSql: () => rootSql,
  embed: embedTheta === null ? null : async () => vecAt(embedTheta),
  embeddingProfile: embedTheta === null
    ? null
    : resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma),
  embeddingMode: embedTheta === null ? null : 'gemma',
  now: () => NOW,
  ...over,
});

let turnSeq = 0;
async function insertTurn(owner: string, theta: number, tsMsAgo: number, over: { verdict?: string } = {}) {
  turnSeq += 1;
  await rootSql`
    INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text,
       text_embedding, text_embedding_mode, text_embedding_profile, turn_origin_verdict)
    VALUES ('default', 'claude', ${'sess-' + owner}, ${turnSeq},
            ${new Date(NOW.getTime() - tsMsAgo).toISOString()}::timestamptz,
            ${owner}, 'assistant', ${'turn ' + turnSeq + ' of ' + owner},
            ${JSON.stringify(vecAt(theta))}::vector,
            'gemma', ${EMBEDDER_DIM_SPECS.gemma.profileId},
            ${over.verdict ?? null})`;
}

let wiSeq = 0;
async function insertWorkItem(owner: string, authority: string, closedMsAgo: number, paths: string[] | null) {
  wiSeq += 1;
  await rootSql`
    INSERT INTO harness_shared.work_items (feature_id, terminal_owner, authority, closed_ts, payload)
    VALUES (${'WI-T' + wiSeq}, ${owner}, ${authority},
            ${NOW.getTime() - closedMsAgo},
            ${paths ? rootSql.json({ paths }) : rootSql.json({})})`;
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `consultr_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
  await rootSql.unsafe('CREATE SCHEMA harness_shared');
  // Only the columns the router reads. ⚠ These names MUST match the real
  // migration-owned schema exactly — a hand-rolled fixture that invents column
  // names makes this suite self-consistent and WRONG. That is not hypothetical:
  // this table previously declared `completion_authority text` / `closed_at
  // timestamptz`, matching the router's SQL but NOT the live schema (which has
  // `authority text` / `closed_ts bigint`). The suite passed green while every
  // consult:get_feedback call in production died on `column
  // "completion_authority" does not exist` (EI-20816404371786180). Verify any
  // column added here against information_schema before trusting a green run.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.session_turns (
      workspace_id text NOT NULL DEFAULT 'default',
      source_kind text NOT NULL,
      session_id text NOT NULL,
      turn_idx integer NOT NULL,
      ts timestamptz,
      owner text,
      speaker text NOT NULL,
      text text NOT NULL,
      ingested_at timestamptz NOT NULL DEFAULT now(),
      text_embedding vector(768),
      text_embedding_mode text,
      text_embedding_profile text,
      text_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', left(text, 20000))) STORED,
      turn_origin_verdict text,
      PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx)
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.work_items (
      feature_id text PRIMARY KEY,
      admission text, admitted_at timestamptz, admitted_by text,
      terminal_owner text,
      authority text,
      closed_ts bigint,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb
    )`);

  // ── The corpus ─────────────────────────────────────────────────────────
  // alpha: highly similar (θ≈0.2), recent, verified, authored the named path.
  await insertTurn('agent-alpha', 0.15, 1 * DAY);
  await insertTurn('agent-alpha', 0.2, 2 * DAY);
  await insertTurn('agent-alpha', 0.25, 3 * DAY);
  for (let i = 0; i < 5; i++) {
    await insertWorkItem('agent-alpha', 'committed', (i + 1) * DAY, [
      'packages/operator-core/lib/consult/relevance-router.ts',
    ]);
  }
  // beta: moderately similar (θ=0.85 → sim≈0.66 vs q=0), STALE (40d), unverified.
  await insertTurn('agent-beta', 0.85, 40 * DAY);
  await insertTurn('agent-beta', 0.9, 41 * DAY);
  // self: the requester's own perfect-similarity turn — must be excluded.
  await insertTurn('agent-self', 0, 1 * DAY);
  // machineonly: near-perfect similarity but machine-surface — must be excluded.
  await insertTurn('agent-machineonly', 0.05, 1 * DAY, { verdict: 'machine-surface' });
  // looponly: near-perfect similarity but agent-injected loop-fire text — must
  // be excluded from the routing evidence just like machine-surface text.
  await insertTurn('agent-looponly', 0.04, 1 * DAY, { verdict: 'agent-injected' });
  // subfloor: sim cos(1.2)≈0.362 < DEFAULT_SIM_FLOOR, but massive fresh track
  // record — the D-003 hard-gate case.
  await insertTurn('agent-subfloor', 1.2, 0.5 * DAY);
  for (let i = 0; i < 50; i++) {
    await insertWorkItem('agent-subfloor', 'committed', (i % 30) * DAY, null);
  }
  // proposed-only closes must NOT count as verification.
  await insertWorkItem('agent-beta', 'proposed', 1 * DAY, null);
}, 120_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

const baseParams = { workspaceId: WS, requesterId: 'agent-self', question: 'how does the consult router work?' };

describe('routeConsult — routing + blend', () => {
  it('routes to the similar+recent+verified owner; snapshot carries the D-008 shape', async () => {
    const r = await routeConsult(baseParams, deps(0));
    expect(r.verdict).toBe('routed');
    expect(r.qualified[0]?.ownerId).toBe('agent-alpha');
    const alpha = r.qualified[0]!;
    expect(alpha.signals.similarity).toBeGreaterThan(0.95); // cos(0.15) ≈ 0.989
    expect(alpha.signals.verification).toBeCloseTo(5 / 9, 2); // 5 committed / (5+4)
    expect(alpha.signals.authorship).toBe(0); // question names no path
    // alpha holds the freshest qualified transcript, so it IS the stage-2
    // reference point: zero relative age, full freshness (D-001 §2).
    expect(alpha.relativeAgeDays).toBe(0);
    expect(alpha.signals.freshness).toBe(1);
    expect(alpha.score).toBeCloseTo(alpha.relevance, 10);
    expect(alpha.evidence.length).toBeGreaterThan(0);
    expect(alpha.evidence[0]).toMatchObject({ session_id: 'sess-agent-alpha' });
    expect(alpha.evidence[0]!.sim).toBeGreaterThan(0.95);
    // Snapshot invariants (persisted verbatim into consult_state.routing).
    expect(r.snapshot.query).toBe(baseParams.question);
    expect(r.snapshot.relevanceFloor).toBe(DEFAULT_RELEVANCE_FLOOR);
    expect(r.snapshot.simFloor).toBe(DEFAULT_SIM_FLOOR);
    expect(r.snapshot.candidates.map((c) => c.ownerId)).toContain('agent-beta');
    expect(r.snapshot.degraded).toBeUndefined();
  });

  it('excludes the requester — a perfect-similarity own turn never self-routes', async () => {
    const r = await routeConsult(baseParams, deps(0));
    const ids = r.snapshot.candidates.map((c) => c.ownerId);
    expect(ids).not.toContain('agent-self');
  });

  it('excludes machine-surface turns — injected boilerplate is not engagement', async () => {
    const r = await routeConsult(baseParams, deps(0));
    const ids = r.snapshot.candidates.map((c) => c.ownerId);
    expect(ids).not.toContain('agent-machineonly');
  });

  it('excludes agent-injected loop-fire turns — replayed carry notes are not engagement', async () => {
    const r = await routeConsult(baseParams, deps(0));
    const ids = r.snapshot.candidates.map((c) => c.ownerId);
    expect(ids).not.toContain('agent-looponly');
  });

  it('does not route an amendment review using a high-similarity fork that reviewed a different rubric', async () => {
    const targetRef = 'acceptance-pui-first-party-public-release-2026-09-07';
    const differentRef = 'acceptance-pui-chat-first-ux-2026-09-28';
    const question =
      `Outside-lineage review of a started acceptance-BAR amendment to ${targetRef}. ` +
      'The relevance router picked you and screened you with rubrics:check-approver.';
    const vectorAt = (theta: number) => {
      const vector = new Array<number>(768).fill(0);
      vector[100] = Math.cos(theta);
      vector[101] = Math.sin(theta);
      return vector;
    };
    const insertReviewTurn = async (owner: string, text: string, theta: number) => {
      turnSeq += 1;
      await rootSql`
        INSERT INTO harness_shared.session_turns
          (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text,
           text_embedding, text_embedding_mode, text_embedding_profile)
        VALUES ('default', 'claude', ${'sess-subject-' + owner}, ${turnSeq}, ${NOW.toISOString()}::timestamptz,
                ${owner}, 'user', ${text}, ${JSON.stringify(vectorAt(theta))}::vector,
                'gemma', ${EMBEDDER_DIM_SPECS.gemma.profileId})`;
    };
    await insertReviewTurn(
      'fork-reviewing-different-rubric',
      `Outside-lineage review of a started acceptance-BAR amendment to ${differentRef}. ` +
        'The relevance router picked you and screened you with rubrics:check-approver.',
      0,
    );
    await insertReviewTurn(
      'reviewer-on-target-rubric',
      `Detailed review notes for rubric ${targetRef}: the amendment changes the acceptance bar and its falsifier.`,
      0.15,
    );

    const routeDeps = { ...deps(0), embed: async () => vectorAt(0) };
    const unscoped = await routeConsult(
      { workspaceId: WS, requesterId: 'review-requester', question },
      routeDeps,
    );
    expect(unscoped.qualified[0]?.ownerId).toBe('fork-reviewing-different-rubric');

    const scoped = await routeConsult(
      { workspaceId: WS, requesterId: 'review-requester', question, subjectRef: targetRef },
      routeDeps,
    );
    expect(scoped.qualified.map((candidate) => candidate.ownerId)).toEqual(['reviewer-on-target-rubric']);
  });

  it('R-13/D-001: 40 days of idleness does NOT disqualify — beta still clears the floor, it just ranks last', async () => {
    // The pre-D-001 router scored beta 0.55×0.660 + 0.15×recency(40d) ≈ 0.38
    // against a 0.5 blended floor and dropped it. That was the vacation defect:
    // beta's TRANSCRIPT never got less relevant, only older. Its relevance is
    // unchanged at ≈0.427, which is above the 0.412 floor, so it qualifies —
    // and the cost of being stale is paid in the ORDERING instead.
    const r = await routeConsult(baseParams, deps(0));
    const beta = r.snapshot.candidates.find((c) => c.ownerId === 'agent-beta');
    expect(beta).toBeDefined();
    expect(beta!.signals.similarity).toBeGreaterThan(0.6);
    expect(beta!.signals.verification).toBe(0); // its only close is 'proposed'
    expect(beta!.relevance).toBeGreaterThanOrEqual(DEFAULT_RELEVANCE_FLOOR);
    expect(r.qualified.map((c) => c.ownerId)).toContain('agent-beta');
    // …and the freshness multiplier is what demotes it: 39 days behind the
    // reference, so it lands below alpha rather than beside it.
    expect(beta!.relativeAgeDays).toBeCloseTo(39, 0);
    expect(beta!.signals.freshness).toBeLessThan(0.3);
    expect(beta!.score).toBeLessThan(r.qualified[0]!.score);
    expect(r.qualified[0]!.ownerId).toBe('agent-alpha');
  });

  it('the freshness multiplier can never zero a qualified expert out of the ranking', async () => {
    // freshness bottoms out at FRESHNESS_BASE, not 0. Without that floor a
    // long-idle expert's score would decay toward zero and the ordering would
    // re-create the disqualification D-001 removed from the floor.
    const r = await routeConsult(baseParams, deps(0));
    const beta = r.snapshot.candidates.find((c) => c.ownerId === 'agent-beta')!;
    expect(beta.signals.freshness).toBeGreaterThanOrEqual(0.2);
    expect(beta.score).toBeGreaterThan(0);
  });

  it('annotates liveness from the injected oracle, defaulting to unknown', async () => {
    const r = await routeConsult(
      baseParams,
      deps(0, { getLiveness: async () => ({ 'agent-alpha': 'live' }) }),
    );
    const alpha = r.snapshot.candidates.find((c) => c.ownerId === 'agent-alpha');
    const beta = r.snapshot.candidates.find((c) => c.ownerId === 'agent-beta');
    expect(alpha!.liveness).toBe('live');
    expect(beta!.liveness).toBe('unknown');
  });

  it('carries the oracle warmIdle signal into the routing snapshot', async () => {
    const r = await routeConsult(
      baseParams,
      deps(0, {
        getLiveness: async () => ({
          'agent-alpha': { sessionState: 'parked', warmIdle: true },
        }),
      }),
    );
    const alpha = r.snapshot.candidates.find((c) => c.ownerId === 'agent-alpha');
    expect(alpha).toMatchObject({ liveness: 'parked', warmIdle: true });
  });

  it('carries the canonical ownerPaused signal into the routing snapshot', async () => {
    const r = await routeConsult(
      baseParams,
      deps(0, {
        getLiveness: async () => ({
          'agent-alpha': { sessionState: 'live', ownerPaused: true },
        }),
      }),
    );
    const alpha = r.snapshot.candidates.find((c) => c.ownerId === 'agent-alpha');
    expect(alpha).toMatchObject({ liveness: 'live', ownerPaused: true });
  });

  it('authorship: a question naming a path boosts the owner whose completed work touched it', async () => {
    const r = await routeConsult(
      { ...baseParams, question: 'who understands packages/operator-core/lib/consult/relevance-router.ts?' },
      deps(0),
    );
    const alpha = r.snapshot.candidates.find((c) => c.ownerId === 'agent-alpha');
    const beta = r.snapshot.candidates.find((c) => c.ownerId === 'agent-beta');
    expect(alpha!.signals.authorship).toBeGreaterThan(0);
    expect(beta!.signals.authorship).toBe(0);
  });
});

describe('routeConsult — D-003 honesty invariants', () => {
  it('far query → first-class no_qualified_responder with the audit-trail candidates kept', async () => {
    const r = await routeConsult(baseParams, deps(-1.3)); // sim to best owner ≈ cos(1.45) ≈ 0.12
    expect(r.verdict).toBe('no_qualified_responder');
    expect(r.qualified).toEqual([]);
    // The snapshot still records what WAS considered — the calibration feed.
    expect(r.snapshot.candidates.length).toBeGreaterThan(0);
    for (const c of r.snapshot.candidates) expect(c.signals.similarity).toBeLessThan(DEFAULT_SIM_FLOOR);
  });

  it('the HARD sim sub-floor blocks a high-track-record owner even when its relevance clears the floor', async () => {
    // Weights tilted toward track record so agent-subfloor's RELEVANCE clears
    // the floor: (sim .362×.3 + ver ~.93×.3) / .7 ≈ 0.55 ≥ 0.41.
    const r = await routeConsult(
      { ...baseParams, weights: { similarity: 0.3, verification: 0.3, authorship: 0.1 } },
      deps(0),
    );
    const sub = r.snapshot.candidates.find((c) => c.ownerId === 'agent-subfloor');
    expect(sub).toBeDefined();
    expect(sub!.relevance).toBeGreaterThanOrEqual(DEFAULT_RELEVANCE_FLOOR); // relevance alone WOULD pass…
    expect(sub!.signals.similarity).toBeLessThan(DEFAULT_SIM_FLOOR); // …but similarity is sub-floor…
    expect(r.qualified.map((c) => c.ownerId)).not.toContain('agent-subfloor'); // …so it must not qualify.
  });

  it('no embedder → unmeasured, NOT a measured absence of qualified peers', async () => {
    const r = await routeConsult(baseParams, deps(null));
    // `no_qualified_responder` would claim similarity was computed and nobody
    // cleared the floor. Nothing was computed here, so the router has no claim
    // to make about the peer population at all (EI-21485716602970457).
    expect(r.verdict).toBe('relevance_unmeasured');
    expect(r.verdict).not.toBe('no_qualified_responder');
    expect(r.qualified).toEqual([]);
    expect(r.snapshot.degraded).toBe('embed-unavailable');
    expect(r.snapshot.candidates).toEqual([]);
  });

  it('no embedder → bounded lexical fallback keeps measurable ranking but no semantic qualification', async () => {
    await rootSql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text, turn_origin_verdict)
      VALUES
        ('default', 'claude', 'sess-lexical-best', 1, ${NOW.toISOString()}::timestamptz,
         'agent-lexical-best', 'assistant', 'consult router fallback evidence for manual review', NULL),
        ('default', 'claude', 'sess-lexical-second', 1, ${new Date(NOW.getTime() - DAY).toISOString()}::timestamptz,
         'agent-lexical-second', 'assistant', 'consult router fallback notes', NULL),
        ('default', 'claude', 'sess-lexical-loop', 1, ${NOW.toISOString()}::timestamptz,
         'agent-lexical-loop', 'assistant', 'consult router fallback evidence for manual review', 'agent-injected')
    `;
    const r = await routeConsult(
      { ...baseParams, question: 'consult router fallback' },
      deps(null, { getLiveness: async (owners) => Object.fromEntries(owners.map((owner) => [owner, 'live'])) }),
    );
    // Lexical candidates DO come back here — which is exactly why the verdict
    // must not read as "nobody qualified": they were never ranked for relevance.
    expect(r.verdict).toBe('relevance_unmeasured');
    expect(r.qualified).toEqual([]);
    expect(r.snapshot.degraded).toBe('embed-unavailable');
    expect(r.snapshot.fallback).toBe('lexical');
    expect(r.snapshot.candidates.map((c) => c.ownerId)).toEqual([
      'agent-lexical-best',
      'agent-lexical-second',
    ]);
    expect(r.snapshot.candidates[0]).toMatchObject({ fallback: 'lexical' });
    expect(r.snapshot.candidates[0]!.score).toBeGreaterThan(0);
    expect(r.snapshot.candidates[0]!.signals.similarity).toBe(0);
    expect(r.snapshot.candidates[0]!.evidence[0]!.lexicalRank).toBeGreaterThan(0);
    expect(r.queryVec).toBeNull();
  });

  it('an embedder that throws degrades the same way', async () => {
    const r = await routeConsult(
      baseParams,
      deps(0, { embed: async () => { throw new Error('sidecar down'); } }),
    );
    expect(r.verdict).toBe('relevance_unmeasured');
    expect(r.snapshot.degraded).toBe('embed-unavailable');
  });
});

// P-007 FALSIFIABILITY CONTROLS — prove each honesty verdict above is caused by
// the mechanism the test names, not vacuously true. A router whose candidate
// discovery silently broke would ALSO answer no_qualified_responder to every
// scenario above; these controls are what make that failure mode detectable.
// (Same calibration-control idiom as the identity-scan gate's "a clean bundle
// passes" test: without a control, fail-on-everything satisfies every assertion.)
describe('routeConsult — P-007 falsifiability controls', () => {
  it('CONTROL: the far-query no-route is FLOOR-driven — zeroed floors ROUTE the identical scenario', async () => {
    // Identical far embedder to the honesty test (sim ≈ 0.12 for the best owner);
    // only the floors change. If this routes, the far-query no_qualified_responder
    // verdict above is attributable to the floors, not to a dead pipeline.
    const r = await routeConsult({ ...baseParams, relevanceFloor: 0, simFloor: 0 }, deps(-1.3));
    expect(r.verdict).toBe('routed');
    expect(r.qualified.length).toBeGreaterThan(0);
    // The audit snapshot must echo the floors ACTUALLY applied (D-008: the
    // persisted routing record is the calibration feed — a snapshot that echoes
    // defaults while overrides governed would poison every later re-grade).
    expect(r.snapshot.relevanceFloor).toBe(0);
    expect(r.snapshot.simFloor).toBe(0);
  });

  it('CONTROL: the routed verdict is floor-governed too — an unreachable floor no-routes the happy path', async () => {
    // Relevance renormalizes a convex combination of [0,1] signals, so it can
    // never exceed 1 and a 1.01 floor is unreachable. If this still routed, the
    // floor filter would be decorative and every no_qualified_responder
    // assertion above would be testing nothing.
    const r = await routeConsult({ ...baseParams, relevanceFloor: 1.01 }, deps(0));
    expect(r.verdict).toBe('no_qualified_responder');
    expect(r.qualified).toEqual([]);
    // Candidates are still recorded — the floor blocks QUALIFICATION, not audit.
    expect(r.snapshot.candidates.length).toBeGreaterThan(0);
  });

  it('CONTROL: the sub-floor exclusion is the SIM sub-floor specifically — zeroing it admits agent-subfloor', async () => {
    // Same tilted weights as the D-003 hard-gate test; only simFloor changes.
    // Qualifying here proves that test excludes agent-subfloor via the sim
    // sub-floor, not via some other filter that would mask a sub-floor regression.
    const r = await routeConsult(
      {
        ...baseParams,
        simFloor: 0,
        weights: { similarity: 0.3, verification: 0.3, authorship: 0.1 },
      },
      deps(0),
    );
    expect(r.qualified.map((c) => c.ownerId)).toContain('agent-subfloor');
  });
});

/**
 * consult-expert-routing-2026-09-22 P-001 — the two-stage router.
 *
 * These own their corpus in a DIFFERENT embedding plane from every fixture
 * above: `vecInPlane(4, …)` / `vecInPlane(6, …)` are orthogonal to the
 * `vecAt()` vectors, so a query here has cosine similarity EXACTLY 0 with the
 * main corpus and none of its owners can clear simFloor. That isolation is
 * load-bearing — the stage-2 reference point is the freshest QUALIFIED
 * candidate, so a stray qualifier from another test's corpus would silently
 * move the baseline these assertions are computed against.
 */
describe('routeConsult — D-001 two-stage: recency compares, never qualifies', () => {
  const vecInPlane = (dim: number, theta: number): number[] => {
    const v = new Array<number>(768).fill(0);
    v[dim] = Math.cos(theta);
    v[dim + 1] = Math.sin(theta);
    return v;
  };
  const planeDeps = (dim: number, theta = 0): ConsultRouteDeps => ({
    ...deps(0),
    embed: async () => vecInPlane(dim, theta),
  });

  let planeSeq = 0;
  async function insertPlaneTurn(owner: string, dim: number, theta: number, tsMsAgo: number) {
    planeSeq += 1;
    await rootSql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text,
         text_embedding, text_embedding_mode, text_embedding_profile)
      VALUES ('default', 'claude', ${'sess-' + owner}, ${planeSeq},
              ${new Date(NOW.getTime() - tsMsAgo).toISOString()}::timestamptz,
              ${owner}, 'assistant', ${'plane turn of ' + owner},
              ${JSON.stringify(vecInPlane(dim, theta))}::vector,
              'gemma', ${EMBEDDER_DIM_SPECS.gemma.profileId})`;
  }

  // Ordering corpus (plane 4). Similarity runs OPPOSITE to freshness on
  // purpose: the STALEST transcript is the most similar. Recency-free
  // relevance therefore ranks stale > mid > fresh, and only the stage-2
  // multiplier can produce the fresh-first order R-9 demands — so an
  // implementation that dropped stage 2 fails on ORDER, not on a tolerance.
  const FRESH = 'plane-fresh';   // θ=0.3, 1d   → sim ≈ 0.955, relevance ≈ 0.618
  const MID = 'plane-mid';       // θ=0.2, 8d   → sim ≈ 0.980, relevance ≈ 0.634
  const STALE = 'plane-stale';   // θ=0.1, 30d  → sim ≈ 0.995, relevance ≈ 0.644
  const ORDERING_OWNERS = [FRESH, MID, STALE];

  const shiftDays = async (owners: string[], days: number) => {
    await rootSql`
      UPDATE harness_shared.session_turns
         SET ts = ts - ${days} * interval '1 day'
       WHERE owner = ANY(${owners}::text[])`;
  };

  beforeAll(async () => {
    await insertPlaneTurn(FRESH, 4, 0.3, 1 * DAY);
    await insertPlaneTurn(MID, 4, 0.2, 8 * DAY);
    await insertPlaneTurn(STALE, 4, 0.1, 30 * DAY);
    // Veteran corpus (plane 6): its ONLY committed completions are far older
    // than the retired 90-day verification window.
    await insertPlaneTurn('plane-veteran', 6, 0.1, 5 * DAY);
    for (let i = 0; i < 4; i++) await insertWorkItem('plane-veteran', 'committed', (200 + i) * DAY, null);
  });

  it('R-13 clause 1 + R-9: every age qualifies, and freshness REVERSES the relevance order', async () => {
    const r = await routeConsult(baseParams, planeDeps(4));
    expect(r.verdict).toBe('routed');
    // Stage 1: all three clear the floor. A 30-day-old transcript is not a
    // worse transcript — this is the assertion the pre-D-001 router failed.
    const byId = new Map(r.snapshot.candidates.map((c) => [c.ownerId, c]));
    for (const owner of ORDERING_OWNERS) {
      expect(byId.get(owner)!.relevance).toBeGreaterThanOrEqual(DEFAULT_RELEVANCE_FLOOR);
    }
    expect(r.qualified.map((c) => c.ownerId).sort()).toEqual([...ORDERING_OWNERS].sort());
    // Recency-free relevance would order them stale-first…
    expect(byId.get(STALE)!.relevance).toBeGreaterThan(byId.get(MID)!.relevance);
    expect(byId.get(MID)!.relevance).toBeGreaterThan(byId.get(FRESH)!.relevance);
    // …and stage 2 inverts that, which is what "materially higher" means.
    expect(r.qualified.map((c) => c.ownerId)).toEqual([FRESH, MID, STALE]);
  });

  it('R-13 clause 2: a UNIFORM time shift leaves every score bit-for-bit unchanged', async () => {
    const before = await routeConsult(baseParams, planeDeps(4));
    const baseline = before.qualified.map((c) => [c.ownerId, c.score, c.relevance, c.relativeAgeDays] as const);
    // Everyone's history ages by the same 90 days — the vacation case, applied
    // to the whole workspace at once.
    await shiftDays(ORDERING_OWNERS, 90);
    try {
      const after = await routeConsult(baseParams, planeDeps(4));
      expect(after.qualified.map((c) => [c.ownerId, c.score, c.relevance, c.relativeAgeDays] as const)).toEqual(
        baseline,
      );
      // Not merely the same ORDER: the same numbers. An absolute decay term
      // would have multiplied every score by 2^(-90/H) here.
      expect(after.qualified[0]!.score).toBe(before.qualified[0]!.score);
    } finally {
      await shiftDays(ORDERING_OWNERS, -90);
    }
  });

  it('CONTROL: shifting ONE candidate DOES change the ranking — the invariance above is not vacuous', async () => {
    // Same instrument, non-uniform shift. If this also came back unchanged,
    // the test above would be proving that recency is ignored entirely rather
    // than that it is measured relatively.
    await shiftDays([FRESH], 60);
    try {
      const r = await routeConsult(baseParams, planeDeps(4));
      expect(r.qualified.map((c) => c.ownerId)).not.toEqual([FRESH, MID, STALE]);
      expect(r.qualified[0]!.ownerId).toBe(MID);
      // Still QUALIFIED though — the shift moved its rank, never its eligibility.
      expect(r.qualified.map((c) => c.ownerId)).toContain(FRESH);
    } finally {
      await shiftDays([FRESH], -60);
    }
  });

  it('D-007(a): the floor sees the FULL candidate list, not the snapshot slice', async () => {
    // maxCandidates:1 is the pre-D-007 killer — the score-ordered cut ran
    // first, so only the top candidate could ever be measured against the
    // floor and MID/STALE were dropped before qualification.
    const r = await routeConsult({ ...baseParams, maxCandidates: 1 }, planeDeps(4));
    expect(r.qualified.map((c) => c.ownerId).sort()).toEqual([...ORDERING_OWNERS].sort());
    // And the persisted snapshot still explains its own verdict: a returned
    // qualifier is never cut out of the audit record it is the result of.
    for (const owner of ORDERING_OWNERS) {
      expect(r.snapshot.candidates.map((c) => c.ownerId)).toContain(owner);
    }
  });

  it('D-007(b): verification counts completions older than the retired 90-day window', async () => {
    const r = await routeConsult(baseParams, planeDeps(6));
    const vet = r.snapshot.candidates.find((c) => c.ownerId === 'plane-veteran');
    expect(vet).toBeDefined();
    // 4 committed closes, ALL ~200 days old. The old trailing window scored
    // this 0 — an expert's track record decaying purely because they were idle,
    // which is the same vacation defect one signal over.
    expect(vet!.signals.verification).toBeCloseTo(4 / 8, 2);
  });

  it('the snapshot records the half-life it compared with, so an ordering stays re-derivable', async () => {
    const r = await routeConsult({ ...baseParams, recencyHalfLifeDays: 3 }, planeDeps(4));
    expect(r.snapshot.recencyHalfLifeDays).toBe(3);
    // A shorter half-life punishes staleness harder — the setting is live, not
    // decorative (P-005 is what will persist it).
    const stale = r.snapshot.candidates.find((c) => c.ownerId === STALE)!;
    const atDefault = (await routeConsult(baseParams, planeDeps(4))).snapshot.candidates.find(
      (c) => c.ownerId === STALE,
    )!;
    expect(stale.score).toBeLessThan(atDefault.score);
    expect(stale.relevance).toBe(atDefault.relevance); // …but qualification is untouched
  });
});

describe('extractPathTokens', () => {
  it('extracts slash paths, trims trailing punctuation, caps at 4, dedupes', () => {
    expect(extractPathTokens('see packages/foo/bar.ts.')).toEqual(['packages/foo/bar.ts']);
    expect(extractPathTokens('no paths here at all')).toEqual([]);
    expect(
      extractPathTokens('a/b.ts c/d.ts a/b.ts e/f.ts g/h.ts i/j.ts'),
    ).toHaveLength(4);
  });
});

describe('fetchTurnExcerpts (P-010 dead-context retrieval — the SQL seam)', () => {
  // Dedicated rows: exact (session_id, turn_idx) match means the router corpus
  // above cannot interfere, and vice versa.
  const SESS = 'sess-excerpt-fixture';
  beforeAll(async () => {
    await rootSql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text, text_embedding)
      VALUES
        ('default', 'claude', ${SESS}, 9001, ${NOW.toISOString()}::timestamptz,
         'agent-exc', 'assistant', ${'long turn: ' + 'y'.repeat(1000)}, ${JSON.stringify(vecAt(0))}::vector),
        ('default', 'claude', ${SESS}, 9002, ${NOW.toISOString()}::timestamptz,
         'agent-exc', 'assistant', 'short turn body', ${JSON.stringify(vecAt(0.1))}::vector)
    `;
  });

  it('round-trips evidence refs to capped excerpt text, best-sim first, skipping misses', async () => {
    const { fetchTurnExcerpts, PLAN_START_EXCERPT_CHARS } = await import('./plan-start-consult');
    const out = await fetchTurnExcerpts(rootSql, WS, [
      {
        ownerId: 'agent-exc',
        evidence: [
          { session_id: SESS, turn_idx: 9002, ts: NOW.toISOString(), sim: 0.9 },
          { session_id: SESS, turn_idx: 9001, ts: NOW.toISOString(), sim: 0.6 },
          // A miss (no such turn) must be skipped, never an error/empty-out.
          { session_id: 'sess-no-such', turn_idx: 1, ts: null, sim: 0.99 },
        ],
      },
    ]);
    // The miss had the top sim but resolves to nothing; the two hits come back
    // ordered by sim desc.
    expect(out.map((e) => e.turn_idx)).toEqual([9002, 9001]);
    expect(out[0].excerpt).toBe('short turn body');
    expect(out[1].excerpt.length).toBe(PLAN_START_EXCERPT_CHARS);
    expect(out[1].excerpt.startsWith('long turn: yyy')).toBe(true);
    expect(out.every((e) => e.ownerId === 'agent-exc')).toBe(true);
  });

  it('caps the injected set at PLAN_START_EXCERPTS_MAX across candidates', async () => {
    const { fetchTurnExcerpts, PLAN_START_EXCERPTS_MAX } = await import('./plan-start-consult');
    const evidence = Array.from({ length: 10 }, (_, i) => ({
      session_id: SESS,
      turn_idx: i % 2 === 0 ? 9001 : 9002,
      ts: null,
      sim: 0.5 + i / 100,
    }));
    const out = await fetchTurnExcerpts(rootSql, WS, [{ ownerId: 'agent-exc', evidence }]);
    expect(out.length).toBeLessThanOrEqual(PLAN_START_EXCERPTS_MAX);
    expect(out.length).toBeGreaterThan(0);
  });
});
