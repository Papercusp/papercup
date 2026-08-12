/**
 * The CLAUDE.md routing-table projection (plan `bash-to-tool-substitution-2026-07-26`,
 * P-019).
 *
 * Two failures are worth catching here, and they are different in kind:
 *
 *  1. THE PROJECTION IS WRONG — a row renders unreadably, a pipe breaks the
 *     column, an unproven pair leaks into prose that every agent reads. These are
 *     properties of `renderRoutingBlock`, tested directly.
 *
 *  2. THE COMMITTED FILE HAS DRIFTED — someone hand-edited the table, or changed a
 *     pair and did not regenerate. CI gates this via `gen:tool-routing:check`, but
 *     a red CI run is a slow, remote way to learn it, so the same assertion runs
 *     here against the real CLAUDE.md.
 *
 * The routing display fields also carry a completeness obligation: a pair that
 * reaches `equivalent` but has no readable routing row is enforced by the gate
 * while being invisible in the table, which is exactly the asymmetry P-019 exists
 * to remove. So the fields are asserted present and sane for every pair.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BEGIN_MARKER,
  END_MARKER,
  renderRoutingBlock,
  routingCell,
  spliceRoutingBlock,
} from './routing-table';
import { ALL_PAIRS } from './pairs';
import { isSqlPair } from './types';
import type { SqlSubstitutionPair, SubstitutionPair } from './types';
import { TOOL_ROUTING_BY_TABLE } from '../pg-read-query';

// lib/bash-substitution → lib → operator-core → packages → repo root (four).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md');

/** A minimal pair stub — only the fields the projection reads. */
const pair = (over: Partial<SubstitutionPair> = {}): SubstitutionPair =>
  ({
    id: 'test.pair',
    intentLabel: 'test-intent',
    bashPattern: /^nope/,
    toolName: 'some:tool',
    advisoryText: 'advisory',
    routing: { want: 'a thing', use: '`some:tool { arg }`', insteadOf: '`nope --flag`' },
    expectedVerdict: 'equivalent',
    cover: () => ({ covered: true }),
    ...over,
  }) as SubstitutionPair;

describe('routingCell', () => {
  it('escapes a pipe so it cannot break the column', () => {
    expect(routingCell('a `… | head` filter')).toBe('a `… \\| head` filter');
  });

  it('does NOT escape a backslash — markdown ignores escapes inside a code span', () => {
    // The bug this prevents: escaping to `\\d` renders LITERALLY as `\\d` inside a
    // code span, so the psql-describe row would advertise the wrong command.
    expect(routingCell('`psql -c "\\d table"`')).toBe('`psql -c "\\d table"`');
  });

  it('collapses whitespace so a cell can never span lines', () => {
    expect(routingCell('a\n  multi   line\tcell')).toBe('a multi line cell');
  });
});

describe('renderRoutingBlock', () => {
  it('emits one row per pair, in registry order', () => {
    const block = renderRoutingBlock([
      pair({ routing: { want: 'first', use: '`a`', insteadOf: '`x`' } }),
      pair({ routing: { want: 'second', use: '`b`', insteadOf: '`y`' } }),
    ]);
    expect(block.indexOf('first')).toBeLessThan(block.indexOf('second'));
    expect(block).toContain('| first | `a` | `x` |');
  });

  it('is wrapped in the marker pair and carries the do-not-edit warning', () => {
    const block = renderRoutingBlock([pair()]);
    expect(block.startsWith(BEGIN_MARKER)).toBe(true);
    expect(block.trimEnd().endsWith(END_MARKER)).toBe(true);
    expect(block).toContain('gen:tool-routing');
  });

  // EI-19463947683316510 — the INVERSE of the D-001 harm described below. That one is
  // advertising a tool that cannot do the job; this one is advertising a tool that CAN,
  // to a reader whose surface cannot LOAD it. An su session's ToolSearch returns nothing
  // for `testing:run` (verified: both the exact `select:` name and a keyword search), so
  // an agent following a row reasonably concludes the guidance is wrong and falls back to
  // the `not` column — the exact bash fallback this table exists to prevent. The tool is
  // in fact fully reachable via `tools:invoke` (verified end-to-end: it ran the suite and
  // returned passed=10). So the table must carry the access path, not just the tool name.
  it('tells a trimmed surface how to reach a tool ToolSearch cannot load', () => {
    const block = renderRoutingBlock([pair()]);
    expect(block).toContain('tools:invoke');
  });

  // D-001, one layer up: a pattern whose replacement is unproven is not enforced,
  // so it must not be ADVERTISED either. Advertising it would send every agent to
  // a tool that cannot do the job — the same harm, delivered by prose.
  it.each(['needs-widening', 'not-a-substitute', 'unaudited'] as const)(
    'OMITS a %s pair — unproven routing never reaches the prose',
    (verdict) => {
      const block = renderRoutingBlock([
        pair({ expectedVerdict: verdict, routing: { want: 'UNPROVEN', use: '`t`', insteadOf: '`b`' } }),
      ]);
      expect(block).not.toContain('UNPROVEN');
    },
  );

  it('keeps an equivalent pair alongside an omitted one', () => {
    const block = renderRoutingBlock([
      pair({ expectedVerdict: 'needs-widening', routing: { want: 'DROPPED', use: '`t`', insteadOf: '`b`' } }),
      pair({ expectedVerdict: 'equivalent', routing: { want: 'KEPT', use: '`t`', insteadOf: '`b`' } }),
    ]);
    expect(block).not.toContain('DROPPED');
    expect(block).toContain('KEPT');
  });

  it('renders a table with no row spilling extra columns', () => {
    const block = renderRoutingBlock(ALL_PAIRS);
    const rows = block.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| you want'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // 3 columns → exactly 4 unescaped pipes. A raw pipe in a cell would add more.
      const unescaped = (row.match(/(?<!\\)\|/g) ?? []).length;
      expect(unescaped, `row has ${unescaped} unescaped pipes: ${row}`).toBe(4);
    }
  });
});

describe('spliceRoutingBlock', () => {
  it('replaces only the marked region, preserving the surrounding prose', () => {
    const doc = `before\n${BEGIN_MARKER}\nold\n${END_MARKER}\nafter\n`;
    const out = spliceRoutingBlock(doc, `${BEGIN_MARKER}\nnew\n${END_MARKER}`);
    expect(out).toBe(`before\n${BEGIN_MARKER}\nnew\n${END_MARKER}\nafter\n`);
    expect(out).not.toContain('old');
  });

  it('is idempotent — splicing the same block twice changes nothing', () => {
    const block = renderRoutingBlock(ALL_PAIRS);
    const doc = `before\n${BEGIN_MARKER}\n${END_MARKER}\nafter\n`;
    const once = spliceRoutingBlock(doc, block);
    expect(spliceRoutingBlock(once, block)).toBe(once);
  });

  it('throws a directive error when the markers are missing, rather than silently doing nothing', () => {
    expect(() => spliceRoutingBlock('no markers here', 'x')).toThrow(/markers not found/);
  });

  it('throws when the markers are inverted', () => {
    expect(() => spliceRoutingBlock(`${END_MARKER}\n${BEGIN_MARKER}`, 'x')).toThrow(
      /precedes/,
    );
  });
});

describe('every audited pair carries a usable routing row', () => {
  it.each(ALL_PAIRS.map((p) => [p.id, p] as const))('%s', (_id, p) => {
    for (const [field, value] of Object.entries(p.routing)) {
      expect(value.trim(), `${p.id}.routing.${field} is empty`).not.toBe('');
      // A table cell, not a paragraph — the advisoryText is where prose belongs.
      expect(value.length, `${p.id}.routing.${field} is too long for a table cell`).toBeLessThan(300);
      expect(value, `${p.id}.routing.${field} spans lines`).not.toContain('\n');
    }
    // The tool the row points at must be the tool the gate enforces, or the table
    // teaches a different routing than the hook applies.
    expect(p.routing.use).toContain(p.toolName);
  });
});

/**
 * D-006's "the two must never disagree about a relation's verb", as a guard.
 *
 * There are TWO surfaces telling an agent which verb answers a relation, and
 * they are reached at different moments: `TOOL_ROUTING_BY_TABLE` fires live, at
 * the instant a hand-written query is submitted, and the CLAUDE.md routing rows
 * are read ambiently in the prompt. A SQL pair that reaches `equivalent` has
 * EARNED its verb against frozen evidence — so the live advisory must not be
 * silent about that relation, and must not name a different verb.
 *
 * The silent case is the one that actually happened: `schema_migrations` and
 * `test_runs` had audited pairs and CLAUDE.md rows while the live map had no
 * entry at all, so the agent most in need of the nudge — the one mid-query —
 * was the only one who never saw it. `engineer_issues` had the other failure,
 * an entry naming a verb that cannot express the shape being routed.
 *
 * Catalog relations are exempt BY NAME: `information_schema.columns` routes to
 * `dev:pg_query { describe }`, and the map is keyed on the BARE relation, which
 * for those pairs would be `columns`/`tables` — words far too generic to key a
 * live advisory on without colliding with an unrelated papercusp table.
 */
describe('an equivalent SQL pair is not contradicted by the live routing advisory', () => {
  const CATALOG_EXEMPT = new Set(['information_schema.columns', 'information_schema.tables']);
  const auditedSqlPairs = ALL_PAIRS.filter(
    (p) => isSqlPair(p) && p.expectedVerdict === 'equivalent' && !CATALOG_EXEMPT.has(p.relation),
  ) as SqlSubstitutionPair[];

  it('covers at least the audited relations (a silent map is the failure being guarded)', () => {
    // `routines` joined the tranche-2 three with the gate-health pair
    // (EI-20285616516435031). Listing them EXACTLY, rather than asserting a
    // minimum, is the point: a new equivalent SQL pair must not slip in without
    // someone confirming the live in-query advisory speaks about its relation
    // too. That confirmation is the per-pair check immediately below; this
    // assertion is what forces a human past it.
    expect(auditedSqlPairs.map((p) => p.relation).sort()).toEqual([
      'engineer_issues',
      'routines',
      'schema_migrations',
      'test_runs',
    ]);
  });

  /**
   * The check itself, as a function, so it can be run against a DELIBERATELY
   * BROKEN map below. A guard that has only ever been run against a passing
   * input has not been shown to be capable of failing — and the repo's
   * falsifiability discipline forbids proving that by mutating the real map,
   * since git-sync would happily commit the mutant mid-probe.
   */
  const disagreement = (p: SqlSubstitutionPair, map: Record<string, { tool: string }>): string | null => {
    const route = map[p.relation];
    if (!route) return `no row for ${p.relation}`;
    if (!route.tool.includes(p.toolName)) return `${p.relation} names "${route.tool}", not ${p.toolName}`;
    return null;
  };

  it.each(auditedSqlPairs.map((p) => [p.id, p] as const))('%s', (_id, p) => {
    expect(
      disagreement(p, TOOL_ROUTING_BY_TABLE),
      `the live advisory contradicts (or is silent about) an audited pair — CLAUDE.md and the in-query nudge would teach different verbs for ${p.relation}`,
    ).toBeNull();
  });

  it('CONTROL: the same check FAILS on a map that is silent about the relation', () => {
    const pair = auditedSqlPairs[0]!;
    expect(disagreement(pair, {})).toMatch(/no row for/);
  });

  it('CONTROL: the same check FAILS on a map naming a different verb', () => {
    const pair = auditedSqlPairs[0]!;
    expect(disagreement(pair, { [pair.relation]: { tool: 'some:other-verb' } })).toMatch(/not /);
  });
});

describe('the committed CLAUDE.md table matches the pairs', () => {
  // Same assertion as `npm run gen:tool-routing:check`, run locally so a stale
  // table is caught by the ordinary test run instead of only by remote CI.
  it('is in sync — run `npm run gen:tool-routing` if this fails', () => {
    const current = readFileSync(CLAUDE_MD, 'utf8');
    expect(current).toContain(BEGIN_MARKER);
    expect(spliceRoutingBlock(current, renderRoutingBlock(ALL_PAIRS))).toBe(current);
  });

  it('advertises every equivalent pair by tool name', () => {
    const current = readFileSync(CLAUDE_MD, 'utf8');
    for (const p of ALL_PAIRS.filter((x) => x.expectedVerdict === 'equivalent')) {
      expect(current, `CLAUDE.md does not mention ${p.toolName}`).toContain(p.toolName);
    }
  });
});
