/**
 * spec-pool-preview.integration.test.ts — WI-5212's COUNT mechanics against real Postgres.
 *
 * The preview's whole value is that it measures the REAL pool with the REAL compiled
 * filter (the same compileFilter get_next executes), so these tests run on a testcontainer
 * like the get_next suites — a mocked count would pin nothing. What must hold:
 *
 *  - the pool applies the neutral floors: status ∈ states, unclaimed, NOT observation-lane
 *    (D-005 — a raw count without this floor overstated the papercusp pool ~7x and produced
 *    a wrong number quoted to a peer leader on 2026-07-17), NOT claim-held (WI-2797);
 *  - `matched` counts through the compiled filter, including the null-safe `not:` semantics
 *    (EI-13306) — a NULL-plan row survives a plan fence;
 *  - starvation #1's exact shape reproduces as matched=0 with a nonempty pool;
 *  - harness scoping and spec.states are honored.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/spec-pool-preview.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { FLAG_DEFAULTS, type FlagKey } from '@papercusp/flags';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  USER_TRUST_LIST_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import type { ClaimSpec, FilterNode } from './claim-spec';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
// EI-18675972728146330: previewSpecPoolEffect now resolves the operator-scope harness alias
// via issuesScopeWorkspace(), which reads the ISSUES_PER_WORKSPACE flag — pin every OTHER key
// to its production default so this stays deterministic (issues scoped to 'default', matching
// WS below), same pattern as claim-issues-claimable.integration.test.ts.
vi.mock('@papercusp/flags/server', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/flags/server')>('@papercusp/flags/server');
  return {
    ...actual,
    getFlag: async (key: FlagKey) => FLAG_DEFAULTS[key] ?? false,
  };
});

const { previewSpecPoolEffect } = await import('./spec-pool-preview');
const { validateClaimSpec } = await import('./claim-spec');

const H = 'papercup';
const WS = 'default';
const PEER_PLAN = 'carry-idle-plans-to-completion-2026-07-17';
let db: FreshPgDb;

function spec(filter: FilterNode, states?: string[]): ClaimSpec {
  const s: ClaimSpec = {
    specVersion: '1.0',
    specId: 'pool-preview',
    revision: 1,
    view: { filter },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    ...(states ? { states } : {}),
  };
  const v = validateClaimSpec(s);
  expect(v.ok, `spec invalid: ${v.errors.join('; ')}`).toBe(true);
  return s;
}

async function seed(
  id: string,
  opts: {
    kind?: string;
    status?: string;
    takenBy?: string | null;
    plan?: string | null;
    payload?: Record<string, unknown> | null;
    harness?: string;
  } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id,
       created_ts, updated_ts, source_plan_slug, title, payload)
    VALUES (${opts.harness ?? H}, ${id}, ${opts.kind ?? 'feature'}, ${opts.status ?? 'open'},
       ${opts.takenBy ?? null}, ${WS}, 0, 0, ${opts.plan ?? null}, ${id},
       ${opts.payload ? db.sql.json(opts.payload as postgres.JSONValue) : null})`;
}

const KIND_ALL: FilterNode = { field: 'kind', op: 'in', value: ['bug', 'change', 'task', 'feature'] };

beforeAll(async () => {
  db = await createFreshPgDb('sched-pool-preview');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
}, 90_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps `;
});

describe('previewSpecPoolEffect — neutral floors define the pool', () => {
  it('excludes observation-lane, claim-held, taken, and wrong-status rows from the POOL', async () => {
    await seed('F-real-1');
    await seed('F-real-2');
    await seed('F-obs', { kind: 'change', payload: { lane: 'observation' } }); // D-005: never claimable
    await seed('F-held', { payload: { _claimHold: true } }); // WI-2797: parked
    await seed('F-taken', { takenBy: 'bee-9' });
    await seed('F-done', { status: 'done' });

    const r = await previewSpecPoolEffect(spec(KIND_ALL), { workspaceId: WS, harness: H });
    expect(r.pool).toBe(2); // only the two real rows
    expect(r.matched).toBe(2);
  });

  it('reproduces starvation #1 exactly: an issue-kind scope over a feature-only pool → matched=0, pool>0', async () => {
    await seed('F-a');
    await seed('F-b');
    const r = await previewSpecPoolEffect(
      spec({ field: 'kind', op: 'in', value: ['bug', 'change', 'task'] }),
      { workspaceId: WS, harness: H },
    );
    expect(r.pool).toBe(2);
    expect(r.matched).toBe(0); // the number the guard refuses on — measured, not inferred
  });

  it('counts a plan fence null-safely (EI-13306): NULL-plan rows SURVIVE, the named plan is fenced', async () => {
    await seed('F-noplan-1', { plan: null });
    await seed('F-noplan-2', { plan: null });
    await seed('F-peer', { plan: PEER_PLAN });
    const r = await previewSpecPoolEffect(
      spec({ all: [KIND_ALL, { not: { field: 'plan', op: '=', value: PEER_PLAN } }] }),
      { workspaceId: WS, harness: H },
    );
    expect(r.pool).toBe(3);
    expect(r.matched).toBe(2); // fences exactly the peer row — 321→3 can never sneak past this count again
  });

  it('honors spec.states (work-item-status-full-unify: `open` is the unified claimable token; `failing` is opt-in re-drive)', async () => {
    await seed('B-open', { kind: 'bug', status: 'open' });
    await seed('F-failing', { status: 'failing' });
    const openOnly = await previewSpecPoolEffect(spec(KIND_ALL), { workspaceId: WS, harness: H });
    expect(openOnly.pool).toBe(1); // default ['open'] — the open bug, not the re-drive-phase feature
    const both = await previewSpecPoolEffect(spec(KIND_ALL, ['open', 'failing']), {
      workspaceId: WS,
      harness: H,
    });
    expect(both.pool).toBe(2);
    expect(both.states).toEqual(['open', 'failing']);
  });

  it('maps a legacy feature `todo` row to unified `open` for a plan-scoped recovery preview', async () => {
    await seed('F-legacy-todo-plan', { status: 'todo', plan: PEER_PLAN });
    await seed('F-other-plan', { plan: 'another-plan' });
    await seed('I-legacy-todo-issue', { kind: 'bug', status: 'todo', plan: PEER_PLAN });

    const r = await previewSpecPoolEffect(
      spec({ all: [KIND_ALL, { field: 'plan', op: '=', value: PEER_PLAN }] }),
      { workspaceId: WS, harness: H },
    );

    // claimFloorsWhereSql folds the retired feature-family storage token `todo` to
    // logical `open`; preview must use the same fold or it falsely rejects the exact
    // plan-scoped recovery spec as a zero-match lane.
    expect(r.pool).toBe(2);
    expect(r.matched).toBe(1);
    expect(r.states).toEqual(['open']);
  });

  it('scopes by harness when given, and counts workspace-wide when omitted', async () => {
    await seed('F-here');
    await seed('F-there', { harness: 'other-harness' });
    const scoped = await previewSpecPoolEffect(spec(KIND_ALL), { workspaceId: WS, harness: H });
    expect(scoped.pool).toBe(1);
    expect(scoped.harness).toBe(H);
    const wide = await previewSpecPoolEffect(spec(KIND_ALL), { workspaceId: WS });
    expect(wide.pool).toBe(2);
    expect(wide.harness).toBeNull();
  });

  it('EI-18675972728146330: admits the operator-scope harness alias, matching the real issue-family claim path — a harness-scoped preview no longer silently undercounts operator:<workspace> rows', async () => {
    await seed('B-plain', { kind: 'bug', harness: H }); // bare harness slug
    await seed('B-operator-alias', { kind: 'bug', harness: 'operator:default' }); // the alias aggregateIssueClaimExclusions also admits
    await seed('B-elsewhere', { kind: 'bug', harness: 'some-other-harness' }); // neither slug — must stay excluded

    const scoped = await previewSpecPoolEffect(spec(KIND_ALL), { workspaceId: WS, harness: H });
    // Before this fix, `pool`/`matched` were both 1 (the alias row was silently dropped,
    // undercounting the write-time collapse guard's own basis pool vs. what
    // work_items:claimable's matchedByFilter — and the real scheduler:get_next claim path —
    // actually admit; confirmed live 78-vs-115-row divergence on nonp2p-bug-drain-0725).
    expect(scoped.pool).toBe(2);
    expect(scoped.matched).toBe(2);

    // A harness-less (workspace-wide) preview is unaffected — it already counted every row.
    const wide = await previewSpecPoolEffect(spec(KIND_ALL), { workspaceId: WS });
    expect(wide.pool).toBe(3);
  });
});
