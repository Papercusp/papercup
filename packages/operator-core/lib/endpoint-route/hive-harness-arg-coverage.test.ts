/**
 * Harness-argument coverage detector (EI-21910110662818467).
 *
 * FALSIFIABILITY: proved by PERMANENT in-suite controls, never by mutating the
 * shared tree. An in-tree mutation probe is unsafe here — git-sync sweeps the
 * whole working tree on a schedule and can COMMIT the mutant even when nothing
 * fails and no handler errors. The controls below are deliberately-wrong inputs
 * that the detector MUST flag, so the suite fails if the detector ever stops
 * detecting; the calibration cases pin the opposite direction (it must not flag
 * what is genuinely safe), so a detector that simply flags everything also
 * fails.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HIVE_CLAMP_ARG_EXEMPTIONS,
  HIVE_CLAMP_LITERAL_ARGS,
  collectHarnessSlugArgs,
  designatesHarness,
  designatesHarnessArg,
  findUnguardedHarnessArgs,
  isClampEnforcedArg,
  schemaMayCarrySlug,
  type HarnessArgCoverageTool,
} from './hive-harness-arg-coverage';

const str = { type: 'string' } as const;
const tool = (name: string, props: Record<string, unknown>): HarnessArgCoverageTool => ({
  name,
  inputSchema: { type: 'object', properties: props },
});

describe('designatesHarness', () => {
  // Every spelling below was MEASURED in the live registry, not imagined.
  it.each([
    'harness',
    'harness_slug',
    'harnessSlug',
    'harness_slugs',
    'hive',
    'hive_slug',
    'sourceHive',
    'targetHive',
    'allHive',
    'targetHarness',
    'target_harness',
    'work_item_harness',
    'workItemHarnessSlug',
    'pot',
    'potSlug',
    'installSlug',
  ])('designates a harness: %s', (arg) => {
    expect(designatesHarness(arg)).toBe(true);
  });

  // TRAP (2) REGRESSION CONTROL: "archived" literally contains "hive".
  // A naive /hive/ test flags all three of these. If this ever goes red, the
  // detector has started reporting archive filters as confinement holes.
  it.each(['archived', 'includeArchived', 'archive_floor', 'archiveFloor'])(
    'does NOT treat archive-related arg as a harness: %s',
    (arg) => {
      expect(designatesHarness(arg)).toBe(false);
    },
  );

  it.each(['scope', 'scopeRef', 'scope_ref', 'ref', 'limit', 'title', 'potentialMatches'])(
    'does NOT designate a harness: %s',
    (arg) => {
      expect(designatesHarness(arg)).toBe(false);
    },
  );
});

describe('schemaMayCarrySlug', () => {
  it('accepts strings and string arrays', () => {
    expect(schemaMayCarrySlug({ type: 'string' })).toBe(true);
    expect(schemaMayCarrySlug({ type: 'array', items: { type: 'string' } })).toBe(true);
    expect(schemaMayCarrySlug({ anyOf: [{ type: 'number' }, { type: 'string' }] })).toBe(true);
  });

  it('rejects types that cannot carry a slug', () => {
    expect(schemaMayCarrySlug({ type: 'number' })).toBe(false);
    expect(schemaMayCarrySlug({ type: 'boolean' })).toBe(false);
    expect(schemaMayCarrySlug({ type: 'array', items: { type: 'number' } })).toBe(false);
  });

  it('FAILS CLOSED on a schema it cannot read', () => {
    // An unreadable schema is exactly the case a human must look at. Passing it
    // through silently is how a hole gets waved into the allowlist.
    expect(schemaMayCarrySlug(undefined)).toBe(true);
    expect(schemaMayCarrySlug({})).toBe(true);
    expect(schemaMayCarrySlug({ description: 'no declared type' })).toBe(true);
  });
});

describe('findUnguardedHarnessArgs — NEGATIVE CONTROLS (must flag)', () => {
  // The detector's job AFTER the clamp sweeps `designatesHarness` args: catch the
  // spelling the predicate does not RECOGNISE. These controls are permanent, so
  // the suite fails if the detector ever stops detecting.
  it('flags a routing-shaped *Slug arg the predicate does not recognise', () => {
    // Exactly the shape of `installSlug` / `potSlug` BEFORE anyone thought to
    // add them by hand — a slug-shaped identifier naming something hive-like.
    const findings = findUnguardedHarnessArgs([tool('control:realm', { realmSlug: str })]);
    expect(findings).toEqual([{ tool: 'control:realm', arg: 'realmSlug' }]);
  });

  it('does NOT chase descriptions (measured dead end — see the module note)', () => {
    // Description-matching flagged ~30 unrelated args in the live registry.
    // Pinned so the noisy leg cannot quietly come back.
    const findings = findUnguardedHarnessArgs([
      tool('control:described', { note: { type: 'string', description: 'a note about the harness' } }),
    ]);
    expect(findings).toEqual([]);
  });

  it('flags a suspicious arg with no declared type (fail-closed)', () => {
    const findings = findUnguardedHarnessArgs([tool('control:untyped', { podSlug: {} })]);
    expect(findings.map((f) => f.arg)).toEqual(['podSlug']);
  });
});

describe('findUnguardedHarnessArgs — CALIBRATION (must NOT flag)', () => {
  // Without these, a detector that flagged everything would pass the controls
  // above and still be useless.
  it('does not flag the args the clamp reads literally', () => {
    const t = tool('calib:literal', Object.fromEntries(HIVE_CLAMP_LITERAL_ARGS.map((a) => [a, str])));
    expect(findUnguardedHarnessArgs([t])).toEqual([]);
  });

  it('does not flag args the clamp now SWEEPS generically', () => {
    // The 12 spellings the first census found unguarded are covered by the
    // generic sweep, so they are answers, not open questions. `harnessSlug`
    // here is the live hole this work closed.
    const t = tool('calib:swept', {
      harnessSlug: str,
      targetHarness: str,
      hive_slug: str,
      sourceHive: str,
      potSlug: str,
      installSlug: str,
      harness_slugs: { type: 'array', items: { type: 'string' } },
    });
    expect(findUnguardedHarnessArgs([t])).toEqual([]);
  });

  it('does not flag a harness-named arg that cannot carry a slug', () => {
    const t = tool('calib:nonslug', { harnessLimit: { type: 'number' }, harnessOnly: { type: 'boolean' } });
    expect(findUnguardedHarnessArgs([t])).toEqual([]);
  });

  it('does not flag archive filters', () => {
    const t = tool('calib:archive', { includeArchived: { type: 'boolean' }, archived: str });
    expect(findUnguardedHarnessArgs([t])).toEqual([]);
  });

  it('does not flag an explicitly exempt arg', () => {
    const [exemptName] = Object.keys(HIVE_CLAMP_ARG_EXEMPTIONS);
    expect(exemptName).toBeTruthy();
    expect(findUnguardedHarnessArgs([tool('calib:exempt', { [exemptName!]: str })])).toEqual([]);
  });

  it('does not treat design-phase filesystem roots as harness selectors', () => {
    expect(HIVE_CLAMP_ARG_EXEMPTIONS.harnessRoot).toContain('filesystem root');
    expect(
      collectHarnessSlugArgs(
        {
          harnessRoot: '/workspace/papercusp',
          workspaceRoot: '/workspace/papercusp-workspaces/papercusp-workspace',
        },
        { toolName: 'design-phase.get_design_spec' },
      ),
    ).toEqual([]);
    expect(
      findUnguardedHarnessArgs([
        tool('design-phase.get_design_spec', { harnessRoot: str, workspaceRoot: str }),
      ]),
    ).toEqual([]);
  });

  it('every exemption states a reason', () => {
    for (const [name, reason] of Object.entries(HIVE_CLAMP_ARG_EXEMPTIONS)) {
      expect(reason.trim().length, `exemption ${name} must state why it is safe`).toBeGreaterThan(20);
    }
  });
});

describe('tool-scoped `slug` — the same name means different things', () => {
  // `slug` appears on 110 tools. On pot:* its own schema says "The pot's
  // home-harness slug", which IS a hive identity; on features:* it is a feature.
  // A name-only rule cannot tell them apart, so this leg takes the tool.
  it.each(['pot:get', 'pot:dissolve', 'pot:obliterate', 'harness:status', 'hive:whatever'])(
    'treats slug as a harness on %s',
    (toolName) => {
      expect(designatesHarnessArg('slug', toolName)).toBe(true);
    },
  );

  it.each(['features:get', 'docs:get', 'artifacts:load', 'plans:get'])(
    'does NOT treat slug as a harness on %s',
    (toolName) => {
      expect(designatesHarnessArg('slug', toolName)).toBe(false);
    },
  );

  it('the clamp sweep picks up pot:obliterate { slug } — the destructive case', () => {
    expect(collectHarnessSlugArgs({ slug: 'other-hive' }, { toolName: 'pot:obliterate' })).toEqual([
      { arg: 'slug', slug: 'other-hive' },
    ]);
  });

  it('the clamp sweep leaves a feature slug alone', () => {
    expect(collectHarnessSlugArgs({ slug: 'some-feature' }, { toolName: 'features:get' })).toEqual([]);
  });

  it('a name-scoped exemption cannot smuggle slug past a pot: tool', () => {
    // `slug` IS in HIVE_CLAMP_ARG_EXEMPTIONS. Enforcement must win on pot:*,
    // or the exemption would re-open the destructive case above.
    expect(HIVE_CLAMP_ARG_EXEMPTIONS.slug).toBeTruthy();
    expect(isClampEnforcedArg('slug', 'pot:obliterate')).toBe(true);
    expect(findUnguardedHarnessArgs([tool('pot:obliterate', { slug: str })])).toEqual([]);
  });
});

/**
 * EI-24646272383071079: `harness:create { slug }` names a harness that does not exist
 * yet, so the clamp compared an unregistered slug against the caller's hive and refused
 * EVERY hive-confined create. The new harness's hive is `pot` (create.ts stamps
 * hive_slug from it), so with `pot` present the sweep checks `pot` alone.
 */
describe('harness:create — the new slug is not a hive reference; pot is', () => {
  it('with pot, the sweep checks only pot (the hive the new harness joins)', () => {
    expect(
      collectHarnessSlugArgs({ slug: 'brand-new', pot: 'my-hive' }, { toolName: 'harness:create' }),
    ).toEqual([{ arg: 'pot', slug: 'my-hive' }]);
  });

  it('a cross-hive pot is still swept, so creating INTO another hive stays refused', () => {
    expect(
      collectHarnessSlugArgs({ slug: 'brand-new', pot: 'other-hive' }, { toolName: 'harness:create' }),
    ).toEqual([{ arg: 'pot', slug: 'other-hive' }]);
  });

  it('without pot, slug stays swept: a hive-less new harness is outside every hive', () => {
    expect(collectHarnessSlugArgs({ slug: 'brand-new' }, { toolName: 'harness:create' })).toEqual([
      { arg: 'slug', slug: 'brand-new' },
    ]);
    // A blank pot is not a hive; it must not switch the slug check off.
    expect(
      collectHarnessSlugArgs({ slug: 'brand-new', pot: '  ' }, { toolName: 'harness:create' }),
    ).toEqual([{ arg: 'slug', slug: 'brand-new' }]);
  });

  it('the exemption is scoped to harness:create — pot:* slug is still a hive reference', () => {
    expect(
      collectHarnessSlugArgs({ slug: 'other-hive', pot: 'my-hive' }, { toolName: 'pot:obliterate' }),
    ).toEqual([
      { arg: 'slug', slug: 'other-hive' },
      { arg: 'pot', slug: 'my-hive' },
    ]);
  });
});

describe('the clamp SWEEP is wired (not just the module)', () => {
  // isClampEnforcedArg claims the generic sweep covers every designatesHarness
  // arg. That claim is only true while _mcp-handler.ts actually calls the sweep;
  // if the call is removed, coverage silently collapses back to four literals
  // and the detector — which trusts the claim — would report all-clear.
  const source = readFileSync(
    fileURLToPath(new URL('./routes/transport/_mcp-host.ts', import.meta.url)),
    'utf8',
  );

  it('_mcp-handler.ts calls collectHarnessSlugArgs WITH the tool name', () => {
    // Without `toolName` the tool-scoped `slug` leg silently does nothing, and
    // pot:obliterate { slug: '<other hive>' } goes back to being unguarded.
    expect(source).toContain('collectHarnessSlugArgs(args, { toolName })');
  });

  it('the sweep rejects rather than merely logging', () => {
    const sweepStart = source.indexOf('for (const { arg, slug } of collectHarnessSlugArgs(');
    expect(sweepStart, 'the sweep loop is missing from _mcp-handler.ts').toBeGreaterThan(-1);
    expect(source.slice(sweepStart, sweepStart + 1200)).toContain('harness_forbidden');
  });
});

describe('collectHarnessSlugArgs — the clamp runtime seam', () => {
  it('does not route a workspace work-scope policy set through its allow-list', () => {
    expect(
      collectHarnessSlugArgs(
        { op: 'set', allowHarnesses: ['papercusp', 'portal'], harnessSlug: 'other-hive' },
        { toolName: 'workspace:work_scope' },
      ),
    ).toEqual([{ arg: 'harnessSlug', slug: 'other-hive' }]);
    expect(
      collectHarnessSlugArgs(
        { op: 'set', allowHarnesses: ['papercusp'] },
        { toolName: 'unrelated:tool' },
      ),
    ).toEqual([{ arg: 'allowHarnesses', slug: 'papercusp' }]);
  });

  it('yields new spellings the clamp never had a branch for', () => {
    expect(collectHarnessSlugArgs({ harnessSlug: 'other-hive' })).toEqual([
      { arg: 'harnessSlug', slug: 'other-hive' },
    ]);
    expect(collectHarnessSlugArgs({ targetHive: 'other-hive' })).toEqual([
      { arg: 'targetHive', slug: 'other-hive' },
    ]);
  });

  it('expands arrays and skips non-slug values', () => {
    expect(collectHarnessSlugArgs({ harness_slugs: ['a', 'b'], harnessLimit: 50, harnessOnly: true })).toEqual([
      { arg: 'harness_slugs', slug: 'a' },
      { arg: 'harness_slugs', slug: 'b' },
    ]);
  });

  it('skips the args the dedicated clamp branches already handle', () => {
    // Those branches carry bespoke narrow exemptions (engineering-docs surfaces,
    // the plans:get/add-decision fleet-leader case); re-checking them generically
    // would silently drop those exemptions.
    expect(collectHarnessSlugArgs({ harness: 'x', harness_slug: 'y', hive: 'z', scope: 'harness:q' })).toEqual([]);
  });

  it('ignores blank and non-object input', () => {
    expect(collectHarnessSlugArgs({ harnessSlug: '   ' })).toEqual([]);
    expect(collectHarnessSlugArgs(null)).toEqual([]);
    expect(collectHarnessSlugArgs(['harnessSlug'])).toEqual([]);
  });
});

describe('HIVE_CLAMP_LITERAL_ARGS is pinned to the real clamp', () => {
  // Stops the list drifting into decoration: a name listed here as "guarded"
  // must correspond to an actual read in the clamp source.
  const source = readFileSync(
    fileURLToPath(new URL('./routes/transport/_mcp-host.ts', import.meta.url)),
    'utf8',
  );

  it.each([...HIVE_CLAMP_LITERAL_ARGS])('the clamp actually reads args.%s', (arg) => {
    // The clamp reads an arg either through the inline cast
    // `(args as Record<string, unknown>).X` or through its `hiveArgs` alias.
    // Anchoring on those two forms keeps the pin meaningful: a bare `\.X` would
    // also match `ctx.harness…`, which would make this assertion vacuous.
    const literalRead = new RegExp(`(?:\\)|hiveArgs\\??)\\.${arg}\\b`);
    expect(literalRead.test(source), `_mcp-handler.ts has no read of args.${arg}`).toBe(true);
  });
});
