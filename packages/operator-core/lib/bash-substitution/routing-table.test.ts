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
  // WI-38337 (D-010): the third routing surface — the hand-written table.
  parseStoragePolicyRoutingTable,
  STORAGE_POLICY_HEADING,
  type HandWrittenRoutingRow,
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
    // (EI-20285616516435031); `work_items` joined TWICE with
    // EI-20285223214931386, because one relation split into two intents — a
    // by-id read served by `work_items:get` and a typed slice served by
    // `work_items:list`. Listing them EXACTLY, rather than asserting a
    // minimum, is the point: a new equivalent SQL pair must not slip in without
    // someone confirming the live in-query advisory speaks about its relation
    // too. That confirmation is the per-pair check immediately below; this
    // assertion is what forces a human past it.
    expect(auditedSqlPairs.map((p) => p.relation).sort()).toEqual([
      'engineer_issues',
      'routines',
      'schema_migrations',
      'test_runs',
      'work_items',
      'work_items',
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

/**
 * WI-38337 / D-010 — the SAME agreement rule, applied to the third surface.
 *
 * The sibling block above guards the LIVE in-query advisory. This one guards
 * CLAUDE.md's HAND-WRITTEN storage-policy table, which until now no test read at
 * all: a row could route `work_items` to some other verb while an audited pair
 * routes it to `work_items:list`, and the suite would stay green.
 *
 * THE RULE IS CONDITIONAL, and that is D-010's whole point. Coverage may differ
 * freely — a hand-written row naming a relation NO pair covers is honest
 * intent-level guidance (`harness_plans` → `plans:list`), and a pair with no row
 * is fine too. A CONTRADICTION is narrower: the row names a relation an audited
 * pair DOES cover, names a verb, and that verb is none of the pair's.
 */
describe('the hand-written storage-policy table is not contradicted by an audited pair', () => {
  const sqlPairs = ALL_PAIRS.filter(
    (p) => isSqlPair(p) && p.expectedVerdict === 'equivalent',
  ) as SqlSubstitutionPair[];
  const byRelation = new Map<string, SqlSubstitutionPair[]>();
  for (const p of sqlPairs) byRelation.set(p.relation, [...(byRelation.get(p.relation) ?? []), p]);
  const relations = [...byRelation.keys()];
  const rows = (): HandWrittenRoutingRow[] =>
    parseStoragePolicyRoutingTable(readFileSync(CLAUDE_MD, 'utf8'), relations);

  /**
   * The check as a function, so the CONTROLs below can run it against a
   * deliberately-wrong row — the same falsifiability discipline as the live-map
   * guard, and for the same reason: mutating the real CLAUDE.md to prove a guard
   * can fail is unsafe here, because git-sync sweeps the tree mid-probe.
   */
  const contradiction = (row: HandWrittenRoutingRow): string | null => {
    if (row.verbs.length === 0) return null; // a prose-only row routes nothing
    for (const rel of row.relations) {
      const pairs = byRelation.get(rel);
      if (!pairs) continue; // coverage may differ — only disagreement is a defect
      const expected = pairs.map((p) => p.toolName);
      if (!row.verbs.some((v) => expected.includes(v))) {
        return `"${row.want}" routes ${rel} to ${row.verbs.join(' / ')}, but the audited pair(s) say ${expected.join(' / ')}`;
      }
    }
    return null;
  };

  it('parses the real table', () => {
    expect(rows().length).toBeGreaterThan(3);
  });

  /**
   * CALIBRATION, and the assertion most likely to save this guard from itself.
   * Every agreement check below is vacuous unless at least one row actually JOINS
   * a pair-covered relation — and a row can stop joining silently, by a reworded
   * `not` cell that no longer names the relation. If this fails because the table
   * legitimately dropped its `work_items` row, that is a one-line fix; a guard
   * that quietly stopped checking anything is not.
   */
  it('CALIBRATION: at least one row actually joins a pair-covered relation', () => {
    const joined = rows().filter((r) => r.relations.some((rel) => byRelation.has(rel)));
    expect(joined.length, 'no hand-written row names a relation any audited pair covers').toBeGreaterThan(0);
  });

  it('no row contradicts an audited pair', () => {
    for (const row of rows()) {
      expect(contradiction(row), 'CLAUDE.md would teach a different verb than the enforced pair').toBeNull();
    }
  });

  it('CONTROL: the same check FAILS on a row routing a covered relation elsewhere', () => {
    const pair = sqlPairs.find((p) => p.relation === 'work_items')!;
    expect(
      contradiction({
        want: 'a filtered slice',
        use: '`issues:list`',
        not: `a hand-written \`harness_shared.${pair.relation}\` query`,
        verbs: ['issues:list'],
        relations: [pair.relation],
      }),
    ).toMatch(/but the audited pair\(s\) say/);
  });

  it('CONTROL: a relation NO pair covers is not a contradiction (coverage may differ)', () => {
    expect(
      contradiction({
        want: 'what plans exist',
        use: '`plans:list`',
        not: 'a hand-written `harness_shared.harness_plans` query',
        verbs: ['plans:list'],
        relations: [],
      }),
    ).toBeNull();
  });

  // Both failure modes THROW rather than returning [], because an empty parse
  // makes every assertion above pass while checking nothing — the exact shape of
  // the defect this guard was filed for.
  it('CONTROL: the parser THROWS rather than silently finding nothing', () => {
    expect(() => parseStoragePolicyRoutingTable('# a doc with no such heading\n', relations)).toThrow(
      /not found in CLAUDE\.md/,
    );
    expect(() => parseStoragePolicyRoutingTable(`${STORAGE_POLICY_HEADING}\n\nprose only.\n`, relations)).toThrow(
      /no table rows under it/,
    );
  });

  /**
   * END-TO-END falsifier. The CONTROLs above hand-build their row, which proves
   * `contradiction()` can fail but bypasses the PARSER — so a parser that never
   * extracted a verb or a relation would still let them pass. This one feeds real
   * markdown through the real parser and requires the contradiction to surface.
   */
  it('CONTROL: a contradicting row written as MARKDOWN is caught end-to-end', () => {
    const doc = `${STORAGE_POLICY_HEADING}\n\n| you want | use | not |\n|---|---|---|\n| a filtered slice | \`issues:list\` | a hand-written \`harness_shared.work_items\` query |\n`;
    const [row] = parseStoragePolicyRoutingTable(doc, relations);
    expect(row!.relations).toContain('work_items');
    expect(row!.verbs).toContain('issues:list');
    expect(contradiction(row!)).toMatch(/but the audited pair\(s\) say/);
  });

  /**
   * A KNOWN IMPRECISION, pinned rather than papered over: verb extraction is a
   * best-effort read of the `use` cell, so a cell that MENTIONS a colon-form
   * token in explanatory text (rather than as a routing target) yields that
   * token as a verb. It is inert — `contradiction()` only consults `verbs` for a
   * row that names a pair-covered relation, and such a row need not name one.
   * The residual risk is one-directional and narrow: since a row passes when ANY
   * named verb matches (correct — a cell may legitimately name two, as the
   * prose/full-text row does), a spurious verb can only ever MASK a
   * contradiction, never invent one.
   *
   * Driven through a FIXTURE, deliberately — this is a property of the PARSER.
   * It was previously pinned to the live gitnexus row, whose explanatory text
   * happened to contain the literal `server:verb`, and was found by matching the
   * prose `want` cell for "code graph". D-042 later reworded that row to
   * "(dot, not colon)", which REMOVED the imprecision entirely; the `find()`
   * then returned undefined and the non-null assertion crashed with a TypeError,
   * holding the green-checkpoint gate red (WI-40232). A parser property must not
   * depend on doc prose the doc is free to improve.
   */
  it('a spurious verb extracted from explanatory prose is inert', () => {
    const doc =
      `${STORAGE_POLICY_HEADING}\n\n| you want | use | not |\n|---|---|---|\n` +
      '| topology | `gitnexus.context` — not the usual `server:verb` form | `gitnexus.query` |\n';
    const [row] = parseStoragePolicyRoutingTable(doc, relations);
    expect(row!.verbs, 'the parser reads a colon-form token out of explanatory prose').toContain(
      'server:verb',
    );
    expect(row!.relations, 'this row names no pair-covered relation').toEqual([]);
    expect(
      contradiction(row!),
      'a spurious verb on a row naming no covered relation cannot invent a contradiction',
    ).toBeNull();
  });

  /**
   * The LIVE gitnexus row, addressed by a STABLE identity — the `use` cell names
   * `gitnexus.context` — rather than by prose in the `want` cell, which is what
   * broke before. D-042 routes topology questions to `gitnexus.context`/`.impact`
   * and warns OFF the raw `gitnexus.query` backend. Because those are dot-form,
   * the cell yields no colon-form verb at all, so the row routes nothing and
   * cannot contradict a pair. Asserting `verbs` is empty is what would notice if
   * the imprecision ever came BACK into this row.
   */
  it('the live gitnexus row routes nothing extractable and contradicts nothing', () => {
    const gitnexus = rows().find((r) => r.use.includes('gitnexus.context'));
    expect(gitnexus, 'CLAUDE.md no longer has a storage-policy row naming gitnexus.context').toBeDefined();
    expect(gitnexus!.verbs, 'dot-form tool names must not parse as colon-form verbs').toEqual([]);
    expect(gitnexus!.relations).toEqual([]);
    expect(contradiction(gitnexus!)).toBeNull();
  });

  // The view `work_items_claimable` is NOT the relation `work_items`. A substring
  // match would read the claimable row as routing `work_items` to
  // `work_items:claimable` and report a false contradiction against the pairs.
  it('does not read `work_items_claimable` as the `work_items` relation', () => {
    const parsed = parseStoragePolicyRoutingTable(
      `${STORAGE_POLICY_HEADING}\n\n| you want | use | not |\n|---|---|---|\n| claimable | \`work_items:claimable\` | the \`work_items_claimable\` view |\n`,
      relations,
    );
    expect(parsed[0]!.relations).toEqual([]);
    expect(contradiction(parsed[0]!)).toBeNull();
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

describe('the projected routing block is identical on every surface it lands in', () => {
  // EI-20429916097018614: gen:tool-routing writes CLAUDE.md directly while AGENTS.md is
  // emitted by the doc-parts projector from the corpus copy of the same block. The two
  // drifted apart for 9 days (codex agents read a routing table missing rows claude
  // agents had) and nothing observed it. Neither copy may drift from the other.
  const extractBlock = (path: string): string => {
    const text = readFileSync(path, 'utf8');
    const si = text.indexOf(BEGIN_MARKER);
    expect(si, `${path} is missing the BEGIN marker`).toBeGreaterThanOrEqual(0);
    const ei = text.indexOf(END_MARKER, si);
    expect(ei, `${path} is missing the END marker`).toBeGreaterThan(si);
    return text.slice(si, ei + END_MARKER.length);
  };

  it('AGENTS.md carries the same generated block as CLAUDE.md, byte for byte', () => {
    expect(extractBlock(join(REPO_ROOT, 'AGENTS.md'))).toBe(extractBlock(CLAUDE_MD));
  });
});
