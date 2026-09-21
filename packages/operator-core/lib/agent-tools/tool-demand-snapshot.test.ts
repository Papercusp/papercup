/**
 * tool-demand-snapshot.test.ts — guards the FROZEN DEMAND SNAPSHOT and the pure
 * half of the refresh CLI that produces it.
 * (deterministic-tool-definition-delivery-2026-09-21 P-002, ruled by D-001 + D-003.)
 *
 * The snapshot is a committed measurement that the tool-delivery generator reads
 * INSTEAD of the live database (D-003), which makes it the one input whose silent
 * corruption would be invisible: a truncated, empty, or hand-edited snapshot still
 * parses as valid JSON and still produces a generated seed — just a wrong one, with
 * a diff that looks deliberate. So the assertions below are mostly about the shapes
 * a BROKEN snapshot takes, not the shape a good one takes.
 *
 * The committed file is read from disk rather than `import`ed so that what is
 * checked is the artifact a reviewer sees in the diff, not a module a bundler or a
 * stale build step resolved on its behalf.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WINDOW_DAYS,
  DEMAND_SQL,
  THIN_SNAPSHOT_FLOOR,
  buildSnapshot,
  judgeThinness,
  parseArgs,
  // @ts-expect-error — plain .mjs CLI with JSDoc types, imported for its pure helpers.
} from '../../../../scripts/refresh-tool-demand.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(HERE, 'tool-demand-snapshot.json');

type DemandRow = { name: string; callers: number; calls: number };
type Snapshot = {
  capturedAt: string;
  windowDays: number;
  window: { start: string; end: string };
  workspace: string;
  sql: string;
  sqlParams: unknown[];
  totals: { calls: number; tools: number; callers: number; unattributedCalls: number };
  tools: DemandRow[];
};

const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;

describe('the committed demand snapshot', () => {
  it('records the window and the exact SQL, so the measurement is reproducible', () => {
    // A snapshot without its window and query is an unfalsifiable number: a reviewer
    // cannot tell a 14-day fleet-wide read from a 1-day single-tenant one, and the two
    // justify completely different seeds.
    expect(snapshot.windowDays).toBeGreaterThan(0);
    expect(Date.parse(snapshot.window.start)).toBeLessThan(Date.parse(snapshot.window.end));
    expect(Math.round((Date.parse(snapshot.window.end) - Date.parse(snapshot.window.start)) / 86_400_000)).toBe(
      snapshot.windowDays,
    );
    expect(snapshot.sql).toBe(DEMAND_SQL);
    expect(snapshot.sqlParams).toEqual([snapshot.window.start, snapshot.window.end, snapshot.workspace]);
    expect(snapshot.workspace).toBeTruthy();
  });

  it('is not a vacuous measurement', () => {
    // THE failure this file exists for. An empty or near-empty snapshot reads as
    // "almost nothing is in demand" rather than as a broken read, and committing one
    // would drop the entire advertised seed on the next generator run.
    expect(judgeThinness(snapshot.totals)).toBeNull();
    expect(snapshot.tools.length).toBeGreaterThanOrEqual(THIN_SNAPSHOT_FLOOR.tools);
    expect(snapshot.totals.callers).toBeGreaterThanOrEqual(THIN_SNAPSHOT_FLOOR.callers);
  });

  it('has totals that agree with the rows they total', () => {
    // Catches a partially-written or hand-trimmed file, where the header still claims
    // the full population while the rows no longer carry it.
    expect(snapshot.totals.tools).toBe(snapshot.tools.length);
    const summedCalls = snapshot.tools.reduce((n, t) => n + t.calls, 0);
    expect(summedCalls).toBe(snapshot.totals.calls);

    // Callers is a DISTINCT count, so it does not sum: the fleet total must sit
    // between the busiest single tool (every one of its callers is a fleet caller)
    // and the union bound. Outside that band the numerator was computed wrong.
    const maxPerTool = Math.max(...snapshot.tools.map((t) => t.callers));
    const summedCallers = snapshot.tools.reduce((n, t) => n + t.callers, 0);
    expect(snapshot.totals.callers).toBeGreaterThanOrEqual(maxPerTool);
    expect(snapshot.totals.callers).toBeLessThanOrEqual(summedCallers);
  });

  it('carries well-formed rows: namespaced names, no negative or impossible counts', () => {
    // TWO separators are real here, and asserting only the common one is a false
    // failure waiting to happen: MCP server verbs are colon form (`work_items:get`)
    // while plugin tools are dot form (`design-phase.search_registry`,
    // `fetch_plus.fetch_clean`) — measured 449 colon / 11 dot across this snapshot.
    // What must NOT appear is a name with no namespace separator at all: that is the
    // client-mangled shape (`mcp__papercusp-su__work_items_get`), which would never
    // match the catalog and would read as a tool nobody uses.
    for (const row of snapshot.tools) {
      expect(row.name, `tool name carries no namespace separator: ${row.name}`).toMatch(
        /^[a-z_][a-zA-Z0-9_-]*[.:][a-zA-Z0-9_.-]+$/,
      );
      expect(row.name, `tool name looks client-mangled: ${row.name}`).not.toMatch(/^mcp__/);
      expect(row.callers).toBeGreaterThanOrEqual(0);
      // A caller makes at least one call, so callers can never exceed calls.
      expect(row.calls, `${row.name} reports more callers than calls`).toBeGreaterThanOrEqual(row.callers);
    }
  });

  it('is dominated by colon-form server verbs, so a wholesale re-mangling is visible', () => {
    // The per-row check above passes for either separator, so it cannot notice the
    // whole catalog flipping form. This one can: dot form is a small plugin minority
    // and a snapshot where it is not is measuring something other than the MCP catalog.
    const colon = snapshot.tools.filter((t) => t.name.includes(':')).length;
    expect(colon / snapshot.tools.length).toBeGreaterThan(0.9);
  });

  it('is sorted by name, so a single tool moving does not reshuffle the diff', () => {
    const names = snapshot.tools.map((t) => t.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size, 'duplicate tool names in the snapshot').toBe(names.length);
  });
});

describe('buildSnapshot', () => {
  const measurement = {
    capturedAt: '2026-09-21T00:00:00.000Z',
    windowDays: DEFAULT_WINDOW_DAYS,
    windowStart: '2026-09-07T00:00:00.000Z',
    windowEnd: '2026-09-21T00:00:00.000Z',
    workspace: 'papercusp-workspace',
    totals: { calls: 30, tools: 3, callers: 5, unattributedCalls: 0 },
    rows: [
      { name: 'work_items:get', callers: 4, calls: 20 },
      { name: 'coord:send', callers: 3, calls: 6 },
      { name: 'tools:find', callers: 2, calls: 4 },
    ],
  };

  it('is deterministic under input reordering', () => {
    // The generator's `--check` drift guard is only meaningful if the same measurement
    // always serialises identically; a row order inherited from the query would make
    // every refresh look like drift.
    const a = buildSnapshot(measurement);
    const b = buildSnapshot({ ...measurement, rows: [...measurement.rows].reverse() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.tools.map((t: DemandRow) => t.name)).toEqual(['coord:send', 'tools:find', 'work_items:get']);
  });

  it('does not mutate the caller rows while sorting', () => {
    const rows = [...measurement.rows];
    buildSnapshot({ ...measurement, rows });
    expect(rows.map((r) => r.name)).toEqual(['work_items:get', 'coord:send', 'tools:find']);
  });

  it('spells an all-workspace capture out in the file rather than leaving it null', () => {
    // `null` in the committed file reads as "field not captured" — the opposite of the
    // deliberate fleet-wide scope it actually means.
    expect(buildSnapshot({ ...measurement, workspace: null }).workspace).toBe('all');
  });
});

describe('judgeThinness', () => {
  it('refuses an empty measurement', () => {
    expect(judgeThinness({ tools: 0, callers: 0 })).toMatch(/believability floor/);
  });

  it('refuses a measurement thin in either dimension alone', () => {
    // A wrong --workspace yields plenty of tools from very few callers; a pruned
    // window yields the reverse. Either one alone is disqualifying.
    expect(judgeThinness({ tools: THIN_SNAPSHOT_FLOOR.tools, callers: THIN_SNAPSHOT_FLOOR.callers - 1 })).toBeTruthy();
    expect(judgeThinness({ tools: THIN_SNAPSHOT_FLOOR.tools - 1, callers: THIN_SNAPSHOT_FLOOR.callers })).toBeTruthy();
  });

  it('accepts a measurement at the floor', () => {
    expect(judgeThinness({ tools: THIN_SNAPSHOT_FLOOR.tools, callers: THIN_SNAPSHOT_FLOOR.callers })).toBeNull();
  });
});

describe('parseArgs', () => {
  it('defaults to a single-tenant window', () => {
    const opts = parseArgs([]);
    expect(opts.windowDays).toBe(DEFAULT_WINDOW_DAYS);
    expect(opts.workspace).toBe('papercusp-workspace');
    expect(opts.dryRun).toBe(false);
    expect(opts.allowThin).toBe(false);
  });

  it('treats --workspace all as the explicit fleet-wide scope', () => {
    expect(parseArgs(['--workspace', 'all']).workspace).toBeNull();
    expect(parseArgs(['--workspace', 'other-pot']).workspace).toBe('other-pot');
  });

  it('rejects a window that cannot produce a measurement', () => {
    expect(() => parseArgs(['--window-days', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--window-days', '-3'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--window-days', '2.5'])).toThrow(/positive integer/);
  });

  it('rejects a flag that swallowed the next flag as its value', () => {
    // `--window-days --dry-run` would otherwise resolve to NaN days and measure nothing.
    expect(() => parseArgs(['--window-days', '--dry-run'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--out'])).toThrow(/requires a value/);
  });

  it('rejects an unknown argument instead of silently ignoring it', () => {
    // A typo'd --windowdays must not quietly fall back to the default window and
    // produce a snapshot measuring something other than what was asked for.
    expect(() => parseArgs(['--windowdays', '30'])).toThrow(/unknown argument/);
  });
});
