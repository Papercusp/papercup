/**
 * coord-tier-gate.test.ts — plan coordination-spec-adoption-2026-08-03, P-009.
 *
 * THIS FILE IS THE GATE, not merely a test of it. WI-6683 measured what happens
 * to a guard that only exists as a script: `check-sql-comment-backtick.mjs` was
 * GREEN the whole time the break it exists to catch sat committed on staging,
 * because nothing ran it on the path where the damage happens. Living here means
 * `test:affected` and the green checkpoint both run it.
 *
 * The pure-predicate tests come first (every branch reachable without a
 * filesystem), then the two assertions against the REAL tree.
 */
import { describe, expect, it } from 'vitest';
import { buildBuiltinToolSourceFiles } from '../static-tool-catalog';
import {
  MIN_TIER_EXEMPTION_REASON,
  UNTIERED_BASELINE,
  UNTIERED_BASELINE_REVIEW_BY,
  collectSeeAlsoPointers,
  extractSeeAlsoRegion,
  isTierExemptCapability,
  judgeCoordBehaviour,
  judgeCoordTierGate,
  parseCoordToolDefs,
  resolveTieredSet,
  scanCoordTierGate,
  untieredBaselineExpired,
} from './coord-tier-gate';
import { DECLARED_COORD_TIERS } from './enforcement-tier-census';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const row = (over: Partial<Parameters<typeof judgeCoordBehaviour>[0]> = {}) => ({
  name: 'coord:newverb',
  capability: 'coord:write',
  exemption: null,
  ...over,
});

describe('judgeCoordBehaviour — the ratchet predicate', () => {
  it('FAILS a new coordination behaviour whose tier resolves to nothing', () => {
    const v = judgeCoordBehaviour(row(), new Set());
    expect(v?.rule).toBe('untiered-coord-behaviour');
  });

  it('passes once a tier RESOLVES — the author fixed it by adding a real mechanism', () => {
    expect(judgeCoordBehaviour(row(), new Set(['coord:newverb']))).toBeNull();
  });

  it('ignores a non-coordination tool entirely', () => {
    expect(judgeCoordBehaviour(row({ name: 'plans:get' }), new Set())).toBeNull();
  });

  it('exempts an operator-capability verb: D-001 ranks how reliably an AGENT is made to act', () => {
    expect(judgeCoordBehaviour(row({ capability: 'operator:write' }), new Set())).toBeNull();
  });

  it('does NOT exempt a verb that merely READS like admin — the capability decides, not the name', () => {
    // Measured 2026-08-03: coord:wake-mode / coord:watermark-set / coord:rebind-identity
    // all carry ordinary coord:write. Guessing from the name was tried first, and was wrong.
    for (const name of ['coord:wake-mode', 'coord:watermark-set', 'coord:rebind-identity']) {
      expect(judgeCoordBehaviour(row({ name, capability: 'coord:write' }), new Set())?.rule).toBe(
        'untiered-coord-behaviour',
      );
    }
  });

  it('accepts an in-literal exemption that carries a real reason', () => {
    expect(judgeCoordBehaviour(row({ exemption: 'x'.repeat(MIN_TIER_EXEMPTION_REASON) }), new Set())).toBeNull();
  });

  it('REFUSES an exemption too short to be a reason — an unfalsifiable one reads as covered', () => {
    const v = judgeCoordBehaviour(row({ exemption: 'because' }), new Set());
    expect(v?.rule).toBe('exemption-unreasoned');
  });

  it('judges a MALFORMED exemption even on a verb that would otherwise be exempt', () => {
    // The baseline forgives an absent decision, never a broken one.
    expect(judgeCoordBehaviour(row({ capability: 'operator:write', exemption: 'nope' }), new Set())?.rule).toBe(
      'exemption-unreasoned',
    );
  });
});

describe('isTierExemptCapability', () => {
  it('is true only for the operator plane', () => {
    expect(isTierExemptCapability('operator:write')).toBe(true);
    expect(isTierExemptCapability('coord:write')).toBe(false);
    expect(isTierExemptCapability('coord:read')).toBe(false);
    expect(isTierExemptCapability(null)).toBe(false);
  });
});

describe('judgeCoordTierGate — grandfathering and hygiene', () => {
  it('does not fail a BASELINED verb, but does fail an unbaselined sibling', () => {
    const out = judgeCoordTierGate({
      rows: [row({ name: 'coord:old' }), row({ name: 'coord:brandnew' })],
      tiered: new Set(),
      baseline: new Set(['coord:old']),
    });
    expect(out.offenders.map((o) => o.name)).toEqual(['coord:brandnew']);
  });

  it('reports a baseline entry that has since earned a tier as STALE, not as passing silently', () => {
    const out = judgeCoordTierGate({
      rows: [row({ name: 'coord:old' })],
      tiered: new Set(['coord:old']),
      baseline: new Set(['coord:old']),
    });
    expect(out.offenders).toEqual([]);
    expect(out.staleBaseline).toEqual(['coord:old']);
  });

  it('reports a coord verb the CATALOG knows but the parser never saw', () => {
    // The load-bearing case: this is the difference between "the tree is clean"
    // and "my scanner is broken". It found a real third tool root on first run.
    const out = judgeCoordTierGate({
      rows: [row({ name: 'coord:seen' })],
      tiered: new Set(['coord:seen']),
      baseline: new Set(),
      catalogue: ['coord:seen', 'coord:invisible', 'plans:get'],
    });
    expect(out.unparsed).toEqual(['coord:invisible']);
  });

  it('leaves `unparsed` ABSENT when no catalogue was supplied — never a misleading empty', () => {
    const out = judgeCoordTierGate({ rows: [row({ name: 'coord:seen' })], tiered: new Set(['coord:seen']) });
    expect(out.unparsed).toBeUndefined();
  });

  it('does not call an UNPARSED baseline entry stale — a broken scanner must not quietly clean the baseline', () => {
    const out = judgeCoordTierGate({
      rows: [],
      tiered: new Set(),
      baseline: new Set(['coord:invisible']),
      catalogue: ['coord:invisible'],
    });
    expect(out.unparsed).toEqual(['coord:invisible']);
    expect(out.staleBaseline).toEqual([]);
  });
});

describe('extractSeeAlsoRegion — bounded, and readable in BOTH shapes', () => {
  it('reads the array form', () => {
    expect(extractSeeAlsoRegion(`seeAlso: ['coord:send (a)', 'coord:read (b)'],`)).toContain('coord:send');
  });

  it('reads the FUNCTION form body — the census cannot, which is why this gate scans source', () => {
    const src = `seeAlso: (result) => {\n  const x = 1;\n  return ['coord:glance (headline)'];\n},`;
    expect(extractSeeAlsoRegion(src)).toContain('coord:glance');
  });

  it('STOPS at the matching bracket, so a neighbouring description cannot fake a tier', () => {
    // Over-crediting HIDES debt — the one direction this census refuses to be wrong in.
    const src = `seeAlso: ['coord:send (a)'],\n  description: 'see coord:impostor for more',`;
    const region = extractSeeAlsoRegion(src)!;
    expect(region).toContain('coord:send');
    expect(region).not.toContain('coord:impostor');
  });

  it('returns null on an unrecognised shape rather than guessing — an unreadable pointer credits nothing', () => {
    expect(extractSeeAlsoRegion('capability: "coord:read",')).toBeNull();
    expect(extractSeeAlsoRegion('seeAlso: [unclosed')).toBeNull();
  });
});

describe('collectSeeAlsoPointers', () => {
  it("credits the LEADING token only, never a verb named incidentally in an entry's prose", () => {
    const src = `defineTool({ name: 'x:y', seeAlso: ['coord:roster { view } (not coord:impostor)'] })`;
    const got = collectSeeAlsoPointers(src);
    expect([...got]).toEqual(['coord:roster']);
  });

  it('collects across BOTH shapes in one file', () => {
    const src =
      `defineTool({ name: 'a:b', seeAlso: ['coord:send (x)'] })\n` +
      `defineTool({ name: 'c:d', seeAlso: (r) => { return ['coord:glance (y)']; } })`;
    expect([...collectSeeAlsoPointers(src)].sort()).toEqual(['coord:glance', 'coord:send']);
  });
});

describe('parseCoordToolDefs', () => {
  it('attributes a marker to the literal that CONTAINS it, in a multi-tool file', () => {
    const src =
      `defineTool({ name: 'coord:one', capability: 'coord:write' })\n` +
      `defineTool({ name: 'coord:two', capability: 'coord:write',\n  // @no-coord-tier ${'r'.repeat(30)}\n})`;
    const rows = parseCoordToolDefs(src);
    expect(rows.map((r) => r.name)).toEqual(['coord:one', 'coord:two']);
    expect(rows[0]!.exemption).toBeNull();
    expect(rows[1]!.exemption).toHaveLength(30);
  });

  it('ignores tools outside the coordination namespace', () => {
    expect(parseCoordToolDefs(`defineTool({ name: 'plans:get', capability: 'coord:read' })`)).toEqual([]);
  });
});

describe('resolveTieredSet — explicit beats derived, same rule as the census', () => {
  it('includes every explicit declaration even with no pointer at all', () => {
    const set = resolveTieredSet(new Set());
    for (const id of DECLARED_COORD_TIERS.keys()) expect(set.has(id)).toBe(true);
  });
});

describe('the grandfather period is bounded', () => {
  it('expires, so "temporary" debt cannot become permanent', () => {
    // An explicit baseline: the shipped one is empty, and an empty baseline never expires.
    const debt = new Set(['coord:unpaid']);
    expect(untieredBaselineExpired('2099-01-01', debt)).toBe(true);
    expect(untieredBaselineExpired('2026-08-03', debt)).toBe(false);
  });

  it('an EMPTY baseline never expires — there is nothing left to grandfather', () => {
    expect(untieredBaselineExpired('2099-01-01', new Set())).toBe(false);
  });

  it('the grandfather period is not overdue: a non-empty baseline past its review date fails here (this test is the reminder)', () => {
    expect(untieredBaselineExpired()).toBe(false);
    expect(UNTIERED_BASELINE_REVIEW_BY).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

/**
 * TEETH. A ratchet that is green on a clean tree has proved nothing — the whole
 * property is "a NEW violation FAILS". These drive the real filesystem seam
 * (walk + parse + judge) over a synthetic repo, so a regression that silently
 * stops finding files is caught too. Never mutate the shared tree to test this:
 * the fleet is editing it concurrently and git-sync commits it within minutes.
 */
describe('THE RATCHET HAS TEETH (synthetic tree, real scan seam)', () => {
  const write = async (root: string, rel: string, body: string) => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const p = join(root, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body, 'utf8');
  };
  const tempRoot = async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'coord-tier-gate-'));
    await write(root, `${TOOLS}/index.ts`, `import './fixture';\n`);
    return root;
  };
  const TOOLS = 'packages/operator-core/lib/agent-tools';

  it('FAILS on a newly added untiered coordination behaviour', async () => {
    const root = await tempRoot();
    await write(
      root,
      `${TOOLS}/fixture.ts`,
      `defineTool({\n  name: 'coord:brand-new',\n  capability: 'coord:write',\n});\n`,
    );
    const r = await scanCoordTierGate(root);
    expect(r.offenders.map((o) => o.name)).toEqual(['coord:brand-new']);
    expect(r.offenders[0]!.rule).toBe('untiered-coord-behaviour');
  }, 30_000);

  it('goes GREEN once a real mechanism is added — a seeAlso pointer from another tool', async () => {
    const root = await tempRoot();
    await write(
      root,
      `${TOOLS}/fixture.ts`,
      `defineTool({\n  name: 'coord:brand-new',\n  capability: 'coord:write',\n});\ndefineTool({\n  name: 'other:tool',\n  seeAlso: ['coord:brand-new (surfaced at result time)'],\n});\n`,
    );
    const r = await scanCoordTierGate(root);
    expect(r.offenders).toEqual([]);
  }, 30_000);

  it('goes GREEN on a reasoned @no-coord-tier, and STAYS RED on an unreasoned one', async () => {
    const root = await tempRoot();
    await write(
      root,
      `${TOOLS}/fixture.ts`,
      `defineTool({\n  name: 'coord:brand-new',\n  capability: 'coord:write',\n  // @no-coord-tier operator-only tuning surface, no agent behaviour to enforce\n});\n`,
    );
    expect((await scanCoordTierGate(root)).offenders).toEqual([]);

    const root2 = await tempRoot();
    await write(
      root2,
      `${TOOLS}/fixture.ts`,
      `defineTool({\n  name: 'coord:brand-new',\n  capability: 'coord:write',\n  // @no-coord-tier because\n});\n`,
    );
    const r2 = await scanCoordTierGate(root2);
    expect(r2.offenders[0]!.rule).toBe('exemption-unreasoned');
  }, 30_000);

  it('does not fire on a grandfathered verb, and fires on the same verb once it is not grandfathered', async () => {
    // The shipped baseline is empty (paid 2026-11-16), so the forgiveness path is
    // driven through the scan seam with an explicit baseline. The second assertion is
    // the property that matters now: nothing is grandfathered by default.
    const root = await tempRoot();
    await write(
      root,
      `${TOOLS}/fixture.ts`,
      `defineTool({\n  name: 'coord:grandfathered',\n  capability: 'coord:write',\n});\n`,
    );
    expect((await scanCoordTierGate(root, { baseline: new Set(['coord:grandfathered']) })).offenders).toEqual([]);
    expect((await scanCoordTierGate(root)).offenders.map((o) => o.name)).toEqual(['coord:grandfathered']);
  }, 30_000);
});

describe('THE GATE, against the real tree', () => {
  it('has no untiered coordination behaviour outside the baseline', async () => {
    const started = performance.now();
    const sources = buildBuiltinToolSourceFiles(ROOT);
    const catalogMs = performance.now() - started;
    console.info(`COORD_TIER_SCAN phase=catalog files=${sources.length} elapsedMs=${Math.round(catalogMs)}`);
    const scanStarted = performance.now();
    const r = await scanCoordTierGate(ROOT);
    console.info(`COORD_TIER_SCAN phase=read-and-parse elapsedMs=${Math.round(performance.now() - scanStarted)}`);
    expect(
      r.offenders.map((o) => `${o.name} [${o.rule}] ${o.file ?? ''}\n      ${o.detail}`),
      "A coordination behaviour must resolve to one of D-001's tiers 1-3. Satisfy it with a REAL mechanism, " +
        "never an assertion: (1) point some tool's seeAlso at it (tier 3, derived, cannot rot); " +
        '(2) add an evidence-carrying entry to DECLARED_COORD_TIERS (tiers 1-2); ' +
        `(3) write "@no-coord-tier <reason, >= ${MIN_TIER_EXEMPTION_REASON} chars>" inside its defineTool literal. ` +
        'Do NOT add to UNTIERED_BASELINE — it is shrink-only.',
    ).toEqual([]);
  }, 30_000);

  it('sees EVERY coord verb the independent catalog knows — a blind scanner reports a false clean', async () => {
    const r = await scanCoordTierGate(ROOT);
    expect(r.unparsed, 'these coord verbs exist but this gate cannot parse them, so it cannot govern them').toEqual([]);
    // A collapsed denominator must not read as progress (the census's own
    // MIN_PLAUSIBLE_COORD_BEHAVIOURS reasoning, applied to the gate).
    expect(r.scanned).toBeGreaterThanOrEqual(20);
  }, 30_000);

  it('carries no stale baseline entries — the set is shrink-only and must not accrue dead weight', async () => {
    const r = await scanCoordTierGate(ROOT);
    expect(r.staleBaseline, 'these no longer need grandfathering — delete them from UNTIERED_BASELINE').toEqual([]);
  }, 30_000);

  it('the baseline is EMPTY: the grandfathered debt was paid and the set is shrink-only', () => {
    // WI-6554700010048916 tiered or exempted every former entry when the review date
    // expired. Re-adding a verb here re-opens debt the gate exists to close: give it a
    // real mechanism instead (see the failure message of the real-tree gate test).
    expect([...UNTIERED_BASELINE]).toEqual([]);
  });
});
