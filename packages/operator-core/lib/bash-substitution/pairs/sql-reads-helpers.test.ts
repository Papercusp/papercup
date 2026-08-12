/**
 * sql-reads-helpers.test.ts — row-selection FIDELITY for the SQL read pairs.
 *
 * ── The failure class this guards, which is not the one model-drift guards ───
 * `model-drift.test.ts` catches the tool and the pair's hand-model diverging:
 * the tool widens or narrows and `cover()` keeps describing the old shape. This
 * file catches something the drift guard structurally cannot see, because both
 * sides can be perfectly in sync and the substitution still be wrong: a
 * translation that is COVERED but answers a NARROWER QUESTION than the SQL did.
 *
 * That is worse than an uncovered atom. An uncovered atom leaves the agent in
 * bash, which is merely the status quo. A narrowing translation reports
 * `covered: true`, renders into the routing table every agent reads, and — once
 * P-020 promotes the row past `tier:'observe'` — is ENFORCED, at which point the
 * agent is pushed off a query returning three rows and onto a call returning one
 * with nothing anywhere saying rows went missing. It is a silent wrong answer,
 * and the audit's own coverage count is what makes it look verified.
 *
 * ── The concrete bug (EI-20285616516435031) ─────────────────────────────────
 * `gateHealthCallFromQuery` originally read only a `name =` / `name LIKE`
 * predicate and defaulted to `name: 'green-checkpoint'` when it found none. But
 * `routines:list` has NO `target_role` filter and its `name` takes exactly one
 * routine, while 19 of the 20 sampled corpus atoms select the row by
 * `target_role = 'system:green-checkpoint'` and never mention `name` at all.
 *
 * So the default was load-bearing for almost the whole corpus, and it was right
 * for every single-routine read — which is exactly why the one multi-routine
 * atom in the sample was invisible: `target_role IN (green-checkpoint, git-sync,
 * release-trigger)` also has no `name` predicate, hit the same default, and was
 * reported covered by a call returning one routine of the three.
 *
 * The assertions below pin the distinction the default cannot make on its own.
 */
import { describe, expect, it } from 'vitest';

import {
  gateHealthCallFromQuery,
  workItemsGetCallFromQuery,
  workItemsListCallFromQuery,
} from './sql-reads-helpers';
import { SQL_READ_PAIRS } from './sql-reads';

const WS = "install_slug='papercusp' AND workspace_id='papercusp-workspace'";

describe('gateHealthCallFromQuery — row selection', () => {
  it('is inert on a query that does not read gate_health', () => {
    // The pair's sqlShape claims only the gate-health corpus; pause/cadence reads
    // of the same relation are a different intent with a different residual.
    expect(gateHealthCallFromQuery(`SELECT name, active FROM harness_shared.routines WHERE ${WS}`)).toBeNull();
  });

  it("maps a single target_role='system:<name>' to that routine's name", () => {
    // The corpus's dominant shape. `target_role` is not a filter routines:list
    // has, so the mapping must go through the row's own `name`.
    const call = gateHealthCallFromQuery(
      `SELECT metadata->'gate_health'->>'consecutiveReds' AS reds FROM harness_shared.routines ` +
        `WHERE target_role='system:green-checkpoint' AND ${WS}`,
    );
    expect(call).toContain('name: "green-checkpoint"');
    expect(call).toContain('installSlug: "papercusp"');
  });

  it('does not assume green-checkpoint for a DIFFERENT single target_role', () => {
    // The default must not outrank an explicit predicate — otherwise a read of
    // some other routine silently becomes a read of the gate.
    const call = gateHealthCallFromQuery(
      `SELECT metadata->'gate_health' FROM harness_shared.routines WHERE target_role='system:git-sync' AND ${WS}`,
    );
    expect(call).toContain('name: "git-sync"');
    expect(call).not.toContain('green-checkpoint');
  });

  it('NEVER narrows a multi-routine target_role IN (...) read to one routine', () => {
    // THE REGRESSION. Three routines in, so the substitution must not pin `name`
    // to any one of them; the faithful answer is the install-scoped superset the
    // caller reads their rows out of.
    const call = gateHealthCallFromQuery(
      `SELECT name, active, metadata->'gate_health'->>'consecutiveReds' AS reds FROM harness_shared.routines ` +
        `WHERE target_role IN ('system:green-checkpoint','system:git-sync','system:release-trigger') AND ${WS}`,
    );
    expect(call).not.toMatch(/\bname:/);
    expect(call).toContain('installSlug: "papercusp"');
  });

  it('honours an explicit name predicate over any target_role inference', () => {
    const call = gateHealthCallFromQuery(
      `select metadata->'gate_health'->>'consecutiveReds' as reds from harness_shared.routines ` +
        `where name='green-checkpoint' and ${WS}`,
    );
    expect(call).toContain('name: "green-checkpoint"');
  });

  it('falls back to green-checkpoint only when the query names no row at all', () => {
    // gate_health is written onto that routine alone, so an unpredicated read is
    // still asking for that row — the default is faithful HERE and only here.
    const call = gateHealthCallFromQuery(
      "SELECT metadata->'gate_health'->>'consecutiveReds' AS reds FROM harness_shared.routines",
    );
    expect(call).toContain('name: "green-checkpoint"');
  });
});

/**
 * ── The work_items pairs (EI-20285223214931386) ──────────────────────────────
 *
 * Same failure class as the gate-health bug above, found the same way — by
 * printing every rendered call and reading it — but arriving through a DIFFERENT
 * door, which is why these cases exist as well as those.
 *
 * The gate-health bug was one wrong DEFAULT. This one was structural: the
 * translator extracted the predicates it recognised and silently ignored the
 * rest. Ten of the first forty sampled atoms rendered a call answering a
 * different question than the SQL — and both pairs scored a clean 20/20 while
 * they did, because the audit only ever consults `cover()`'s boolean.
 *
 * Every case below is a REGRESSION of an atom that really appeared in the
 * corpus, not an invented shape. A dropped predicate fails in whichever
 * direction the predicate pointed — `status NOT IN (…)` dropped WIDENS the
 * answer, an OR-branch dropped NARROWS it — so both directions are pinned here.
 */
describe('work_items pairs — a predicate the verb cannot express is not silently dropped', () => {
  const byId = SQL_READ_PAIRS.find((p) => p.id === 'sql.work-items-by-id')!;
  const search = SQL_READ_PAIRS.find((p) => p.id === 'sql.work-items-search')!;
  const claims = (pair: typeof byId, atom: string): boolean => pair.sqlShape!.test(atom);

  it('translates the dominant by-id read, terminal columns and all', () => {
    const call = workItemsGetCallFromQuery(
      "SELECT feature_id, status, taken_by, terminal_owner FROM harness_shared.work_items WHERE feature_id = 'EI-123' AND harness_slug = 'papercusp'",
    );
    expect(call).toBe('work_items:get { id: "EI-123", harness: "papercusp" }');
  });

  it('batches an IN-list into one ids call', () => {
    expect(workItemsGetCallFromQuery("SELECT id FROM w WHERE feature_id IN ('WI-1','WI-2')")).toBe(
      'work_items:get { ids: ["WI-1", "WI-2"] }',
    );
  });

  it("declines an id batch beyond the verb's 100-per-call ceiling", () => {
    const ids = Array.from({ length: 101 }, (_, i) => `'WI-${i}'`).join(',');
    expect(workItemsGetCallFromQuery(`SELECT id FROM w WHERE feature_id IN (${ids})`)).toBeNull();
  });

  // The payload/summary trigger must not be anchored on `->`: this atom reads the
  // payload through a function call with no arrow anywhere in it, and an
  // arrow-anchored test rendered the DEFAULT tier — which drops `payload`
  // entirely, i.e. exactly the field the query exists to read.
  it('asks for the full tier when the payload is read WITHOUT an arrow', () => {
    expect(
      workItemsGetCallFromQuery("SELECT jsonb_object_keys(payload) AS k FROM w WHERE feature_id='WI-6512'"),
    ).toContain('payloadTier: "full"');
  });

  // `workspace_id` ends in `id`. Without a word boundary the by-id selector
  // matched its tail, so a scope-only query read as an id read — and the search
  // pair's negative lookahead excluded every query mentioning `workspace_id`.
  it('does not mistake workspace_id for an id selector', () => {
    expect(claims(byId, "SELECT DISTINCT harness_slug FROM w WHERE workspace_id='papercusp-workspace'")).toBe(false);
  });

  // CALIBRATION for the refusals below. Every one of those asserts that a shape
  // does NOT claim an atom — and all of them would pass just as happily if the
  // shape matched NOTHING AT ALL. These two say the shapes still claim the
  // ordinary reads they exist for, so a refusal means "this shape is discerning"
  // rather than "this shape is broken".
  it('CALIBRATION: the shapes do claim the ordinary reads they exist for', () => {
    expect(
      claims(byId, "SELECT feature_id, status FROM harness_shared.work_items WHERE feature_id = 'WI-1' AND harness_slug = 'papercusp'"),
    ).toBe(true);
    expect(
      claims(search, "SELECT feature_id, status FROM harness_shared.work_items WHERE title ILIKE '%census%' AND status = 'open'"),
    ).toBe(true);
  });

  it.each([
    ['state NOT IN — dropping it WIDENS the answer', "SELECT id FROM w WHERE title ILIKE '%x%' AND state NOT IN ('done','dropped')"],
    ['IS NULL — not expressible as a filter argument', "SELECT id FROM w WHERE status = 'open' AND taken_by IS NULL"],
    ['a time window — the verb has no time argument at all', "SELECT id FROM w WHERE status='open' AND created_at > '2026-08-01'"],
    ['an OR across two columns — the verb ANDs its filters', "SELECT id FROM w WHERE title ILIKE '%v%' OR payload::text ILIKE '%v%'"],
    ['a lane filter — there is an include-observations boolean, not a lane arg', "SELECT id FROM w WHERE lane = 'observation' AND title LIKE '%x%'"],
    ['an unprojected column — the rows would come back without it', "SELECT terminal_reason FROM w WHERE status = 'open'"],
  ])('search pair does not claim: %s', (_why, atom) => {
    expect(claims(search, atom)).toBe(false);
  });

  it('by-id pair does not claim an OR between an id and another column', () => {
    expect(claims(byId, "SELECT feature_id FROM w WHERE taken_by='su-1' OR feature_id='WI-5481'")).toBe(false);
  });

  // The flag is unconditional by design. `work_items:list` drops observation-lane
  // rows by default while the raw SELECT returns them, so omitting it renders a
  // call answering with FEWER rows than were asked for.
  it('always requests observation rows, which the verb otherwise omits', () => {
    expect(workItemsListCallFromQuery("SELECT id FROM w WHERE state='wip'")).toContain('includeObservations: true');
  });

  it("maps the DB spellings onto the verb's argument names", () => {
    const call = workItemsListCallFromQuery(
      "SELECT id FROM w WHERE status='open' AND item_kind='feature' AND taken_by='su-9' AND harness_slug='papercusp'",
    );
    // status→state, item_kind→kind, taken_by→assignee, harness_slug→harness.
    expect(call).toContain('state: "open"');
    expect(call).toContain('kind: "feature"');
    expect(call).toContain('assignee: "su-9"');
    expect(call).toContain('harness: "papercusp"');
  });
});
