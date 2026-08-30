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
  findUnguardedHarnessArgs,
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
  it('flags a tool that declares an unguarded harness-naming arg', () => {
    const findings = findUnguardedHarnessArgs([tool('control:unguarded', { targetHarness: str })]);
    expect(findings).toEqual([{ tool: 'control:unguarded', arg: 'targetHarness' }]);
  });

  it('TRAP (1) REGRESSION CONTROL: flags camelCase harnessSlug even though harness_slug is guarded', () => {
    // This is the live hole the detector found on its first run (34 tools).
    // The clamp reads properties LITERALLY, so `harnessSlug` is a different key
    // from the guarded `harness_slug`. An earlier draft normalized both to
    // "harnessslug" and reported this as GUARDED — the detector concealing the
    // exact bug it exists to find. If this test ever goes green-by-normalizing
    // again, that regression is back.
    const findings = findUnguardedHarnessArgs([tool('control:camel', { harnessSlug: str })]);
    expect(findings).toEqual([{ tool: 'control:camel', arg: 'harnessSlug' }]);
  });

  it('flags a slug-bearing ARRAY arg', () => {
    const findings = findUnguardedHarnessArgs([
      tool('control:array', { harness_slugs: { type: 'array', items: { type: 'string' } } }),
    ]);
    expect(findings.map((f) => f.arg)).toEqual(['harness_slugs']);
  });

  it('flags an untyped harness arg (fail-closed)', () => {
    const findings = findUnguardedHarnessArgs([tool('control:untyped', { someHarnessRef: {} })]);
    expect(findings.map((f) => f.arg)).toEqual(['someHarnessRef']);
  });
});

describe('findUnguardedHarnessArgs — CALIBRATION (must NOT flag)', () => {
  // Without these, a detector that flagged everything would pass the controls
  // above and still be useless.
  it('does not flag the args the clamp guards literally', () => {
    const t = tool('calib:guarded', Object.fromEntries(HIVE_CLAMP_LITERAL_ARGS.map((a) => [a, str])));
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

  it('every exemption states a reason', () => {
    for (const [name, reason] of Object.entries(HIVE_CLAMP_ARG_EXEMPTIONS)) {
      expect(reason.trim().length, `exemption ${name} must state why it is safe`).toBeGreaterThan(20);
    }
  });
});

describe('collectHarnessSlugArgs — the clamp runtime seam', () => {
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
    fileURLToPath(new URL('./routes/transport/_mcp-handler.ts', import.meta.url)),
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
