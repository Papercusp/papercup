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
  isCanonicalTerminalUnion,
} from './sql-reads-helpers';
import { SQL_READ_PAIRS } from './sql-reads';
// WI-38339: the drift guard below builds its atom FROM the canonical union, so a
// state added to (or removed from) it re-points the test instead of stranding it.
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';

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
    ['IS NULL — not expressible as a filter argument', "SELECT id FROM w WHERE status = 'open' AND taken_by IS NULL"],
    // WI-38339 widened the verb to an INCLUSIVE `>=` window. An exclusive `>` is
    // still left to SQL — rendering it as `createdSince` would shift the boundary
    // by exactly the rows sitting on it, which no reader can see in the result.
    ['an EXCLUSIVE time bound — createdSince is >=, and the difference is invisible', "SELECT id FROM w WHERE status='open' AND created_at > '2026-08-01'"],
    // A `now()`-relative bound re-evaluates per run; a rendered constant does not.
    ['a now()-relative window — the rendered constant would be a different query', "SELECT id FROM w WHERE status='open' AND created_at >= now() - interval '7 days'"],
    ['an OR across two columns — the verb ANDs its filters', "SELECT id FROM w WHERE title ILIKE '%v%' OR payload::text ILIKE '%v%'"],
    ['a lane filter — there is an include-observations boolean, not a lane arg', "SELECT id FROM w WHERE lane = 'observation' AND title LIKE '%x%'"],
    ['an unprojected column — the rows would come back without it', "SELECT terminal_reason FROM w WHERE status = 'open'"],
  ])('search pair does not claim: %s', (_why, atom) => {
    expect(claims(search, atom)).toBe(false);
  });

  it('by-id pair does not claim an OR between an id and another column', () => {
    expect(claims(byId, "SELECT feature_id FROM w WHERE taken_by='su-1' OR feature_id='WI-5481'")).toBe(false);
  });

  // WI-38365. Each entry of UNPROJECTED_BY_BOTH, pinned individually.
  //
  // The denylist was challenged as an accidental over-refusal and re-verified
  // against the live verb (method + control in the constant's comment): all seven
  // columns are genuinely absent from a full-tier `work_items:get`, so refusing
  // these atoms is correct rather than fussy. It is a REAL population — ~88 by-id
  // calls over 7d — which is exactly why a later reader is tempted to widen it.
  //
  // Each case asserts BOTH halves on the same atom: refused WITH the column,
  // claimed WITHOUT it. The paired half is what makes the refusal meaningful — a
  // one-sided `toBe(false)` passes just as happily if the shape has stopped
  // matching anything at all, which is the failure this table is here to catch.
  //
  // ⚠ If one of these starts failing, the fix is NOT to delete the entry. It means
  // the verb now projects that column; delete it from UNPROJECTED_BY_BOTH (which
  // makes this case pass again by widening the pair, the intended direction) and
  // update the constant's comment. Deleting only the test re-arms the silent
  // over-refusal it exists to detect.
  it.each([
    ['notes', "SELECT feature_id, notes FROM w WHERE feature_id = 'WI-1'"],
    ['terminal_reason', "SELECT feature_id, terminal_reason FROM w WHERE feature_id = 'WI-1'"],
    ['condition_key', "SELECT feature_id, condition_key FROM w WHERE feature_id = 'WI-1'"],
    ['feature_order', "SELECT feature_id, feature_order FROM w WHERE feature_id = 'WI-1'"],
    ['source_plan_item_ids', "SELECT feature_id, source_plan_item_ids FROM w WHERE feature_id = 'WI-1'"],
    ['needs_human_review', "SELECT feature_id, needs_human_review FROM w WHERE feature_id = 'WI-1'"],
    ['completion_ref', "SELECT feature_id, completion_ref FROM w WHERE feature_id = 'WI-1'"],
  ])('by-id pair refuses a query PROJECTING %s, which the verb does not return', (_col, atom) => {
    expect(claims(byId, atom)).toBe(false);
    // The identical read WITHOUT that column is claimed — so the refusal is about
    // the projection, not about the shape having gone inert.
    expect(claims(byId, "SELECT feature_id FROM w WHERE feature_id = 'WI-1'")).toBe(true);
  });

  // `\b` keeps `completion_ref` from matching inside `terminal_completion_ref`,
  // which the verb DOES return. Without the boundary this whole family of
  // forensic reads would be refused for a column that is served.
  it('by-id pair still claims terminal_completion_ref, which IS projected', () => {
    expect(claims(byId, "SELECT feature_id, terminal_completion_ref FROM w WHERE feature_id = 'WI-1'")).toBe(true);
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

  /* ── WI-38339: the four widened slices ────────────────────────────────────────
   *
   * The tool grew `states` / `notTerminal` / `createdSince` / `updatedSince` /
   * `sourcePlanSlug`; this pair had to be widened DELIBERATELY to match, because
   * its shape is a positive whitelist. The division of labour these tests pin:
   * the SHAPE decides syntax, `cover()` decides semantics. Two of the three
   * remaining refusals below are only expressible in `cover()` — set equality
   * against the terminal union, and whether a column is PROJECTED — so a test
   * asserting them on the shape alone would be asserting the wrong thing.
   */

  const covers = (pair: typeof search, atom: string): boolean => pair.cover!(atom).covered;

  // CALIBRATION, and not a formality: every refusal below would also pass against
  // a widening that matched nothing at all. This says each new slice really is
  // claimed, so the refusals mean "discerning" rather than "inert".
  it('CALIBRATION: the widened shape claims each new slice', () => {
    const atoms = [
      "SELECT id FROM harness_shared.work_items WHERE status IN ('open','wip') AND harness_slug='papercusp'",
      "SELECT id FROM harness_shared.work_items WHERE status NOT IN ('done','dropped','resolved','closed','passed','deprecated')",
      "SELECT id FROM harness_shared.work_items WHERE source_plan_slug = 'my-plan'",
      "SELECT id FROM harness_shared.work_items WHERE created_at >= '2026-08-01' AND status='open'",
    ];
    for (const atom of atoms) {
      expect(claims(search, atom), atom).toBe(true);
      expect(covers(search, atom), atom).toBe(true);
    }
  });

  it('renders a state SET as `states`, lowercased', () => {
    const call = workItemsListCallFromQuery("SELECT id FROM w WHERE status IN ('OPEN','wip')");
    expect(call).toContain('states: ["open", "wip"]');
  });

  // THE HIGH-VALUE CASE. Measured over 7d of real agent SQL naming `work_items`:
  // 100 statements carry a NOT-IN state list, and the dominant ones enumerate this
  // exact union in a dozen different ORDERS — hand-copied terminal sets, which is
  // the drift ANY_FAMILY_TERMINAL_STATES exists to end. Order must not matter.
  it('renders a scrambled copy of the canonical terminal union as notTerminal', () => {
    const call = workItemsListCallFromQuery(
      "SELECT id FROM w WHERE state NOT IN ('passed','deprecated','resolved','closed','done','dropped')",
    );
    expect(call).toContain('notTerminal: true');
  });

  // A PROPER SUBSET is the trap: `notTerminal` would additionally exclude
  // resolved/closed/passed/deprecated, answering with FEWER rows than were asked
  // for. The shape admits the syntax so this check can run; cover() refuses it.
  it('refuses an exclusion set that is not the canonical terminal union', () => {
    const subset = "SELECT id FROM w WHERE title ILIKE '%x%' AND state NOT IN ('done','dropped')";
    expect(claims(search, subset)).toBe(true);
    expect(covers(search, subset)).toBe(false);
    const superset = "SELECT id FROM w WHERE state NOT IN ('done','dropped','resolved','closed','passed','deprecated','blocked')";
    expect(covers(search, superset)).toBe(false);
  });

  // DRIFT GUARD: `notTerminal` is servable only against the SOURCE constant. If a
  // state is ever added to or removed from the union, a hard-coded copy in the
  // renderer would keep claiming the old set — silently, since a wrong exclusion
  // still returns plausible rows. Built FROM the constant, so it cannot lag it.
  it('tracks ANY_FAMILY_TERMINAL_STATES rather than a copy of its members', () => {
    const fromSource = `SELECT id FROM w WHERE status NOT IN (${ANY_FAMILY_TERMINAL_STATES.map((s) => `'${s}'`).join(',')})`;
    expect(workItemsListCallFromQuery(fromSource)).toContain('notTerminal: true');
    expect(isCanonicalTerminalUnion([...ANY_FAMILY_TERMINAL_STATES])).toBe(true);
    // …and one state short of it is not the union, whatever the union becomes.
    expect(isCanonicalTerminalUnion(ANY_FAMILY_TERMINAL_STATES.slice(1))).toBe(false);
  });

  it('renders a plan-of-origin filter, and an INCLUSIVE created/updated window', () => {
    expect(workItemsListCallFromQuery("SELECT id FROM w WHERE source_plan_slug='my-plan'")).toContain(
      'sourcePlanSlug: "my-plan"',
    );
    const windowed = workItemsListCallFromQuery(
      "SELECT id FROM w WHERE created_at >= '2026-08-01' AND updated_at >= '2026-08-05'",
    );
    expect(windowed).toContain('createdSince: "2026-08-01"');
    expect(windowed).toContain('updatedSince: "2026-08-05"');
  });

  // The PROJECTION half of the widening. The verb can now FILTER on the window,
  // but its default tiers project neither timestamp — so a query that READS the
  // column it filters on must be sent to the full tier, exactly as the by-id pair
  // does for `payload`. A WHERE-only mention needs no wider result.
  it('asks for the full tier only when a timestamp is actually SELECTED', () => {
    expect(workItemsListCallFromQuery("SELECT id, created_at FROM w WHERE created_at >= '2026-08-01'")).toContain(
      'payloadTier: "full"',
    );
    expect(workItemsListCallFromQuery("SELECT id, title FROM w WHERE created_at >= '2026-08-01'")).not.toContain(
      'payloadTier',
    );
  });

  // FILTERING on source_plan_slug is served; PROJECTING it is not — the verb
  // carries it on feature-family rows only, so half the rows would come back
  // without the column the query exists to read.
  it('refuses a source_plan_slug PROJECTION while serving the filter', () => {
    expect(covers(search, "SELECT id, source_plan_slug FROM w WHERE status='open'")).toBe(false);
    expect(covers(search, "SELECT id, title FROM w WHERE source_plan_slug='my-plan'")).toBe(true);
  });
});
