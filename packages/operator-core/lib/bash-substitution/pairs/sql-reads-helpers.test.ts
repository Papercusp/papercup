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

import { gateHealthCallFromQuery } from './sql-reads-helpers';

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
