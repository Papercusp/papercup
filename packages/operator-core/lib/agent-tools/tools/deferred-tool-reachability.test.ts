/**
 * R-8 — A DEFERRED TOOL IS STILL REACHABLE, END TO END.
 *
 * Plan: deterministic-tool-definition-delivery-2026-09-21 (P-011), Decisions
 * D-020 / D-023 / D-024.
 *
 * WHY THIS FILE EXISTS. The shipping seed advertises 63 of 899 tools and
 * DEFERS the other 836. Deferral is only safe because a deferred tool remains
 * reachable: `tools:find` discovers it by intent, and `tools:invoke` dispatches
 * it by its colon-form name. Before this file, NO bar executed that route:
 *
 *   - R-4 asserts a floor tool is PRESENT at compact tier. Presence is not
 *     reachability.
 *   - `_tool-reachability.test.ts` asserts a refusal HINT contains the literal
 *     strings 'tools:find' and 'tools:invoke'. Naming the route is not the
 *     route working.
 *
 * So the mechanism was attested only by agents incidentally using it, and an
 * incidental demonstration leaves nothing that FAILS when it breaks. D-023
 * measured the cost of the discovery half failing: agents that could not find
 * a deferred tool INVENTED plausible names (`activity:tool-log`,
 * `locks:audit`, `coord:feed`) and dispatched them anyway — and the full-tier
 * control arm did so MORE often than the compact arm, which is why this bar is
 * about DEFERRAL rather than about compaction.
 *
 * FALSIFIABILITY. Every positive assertion here is paired with a control:
 * an advertised tool proves the tier lookup resolves (so "absent from tiers"
 * means deferred, not "artifact failed to load"), and a fabricated name proves
 * corpus membership discriminates (so "the corpus contains X" is not vacuously
 * true of every string). The calibration case fails loudly if a future seed
 * promotes a probe tool, forcing re-selection instead of a silent vacuous pass.
 *
 * Run with:
 *   npx vitest run packages/operator-core/lib/agent-tools/tools/deferred-tool-reachability.test.ts
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

// Force lexical-only discovery: no embedder, no network, no DB — the same
// graceful-degrade mode find.test.ts pins, so ranking here is deterministic.
vi.mock('../search/embedder', () => ({
  buildQueryEmbedder: vi.fn().mockResolvedValue(null),
  interactiveEmbedAcquireBudgetMs: () => 4000,
}));

const hiveMocks = vi.hoisted(() => ({ potHomeSlugForHarness: vi.fn() }));
const pluginHostMocks = vi.hoisted(() => ({ getPluginHost: vi.fn() }));

vi.mock('../../hive-federation', () => ({
  potHomeSlugForHarness: hiveMocks.potHomeSlugForHarness,
}));
vi.mock('../../plugin-host-runtime', () => ({
  getPluginHost: pluginHostMocks.getPluginHost,
}));

import toolFind, { buildCorpus } from './find';
import toolInvoke from './invoke';

// Importing a tool module registers it. These four are a representative slice
// of the DEFERRED set and are deliberately load-bearing ones: three of them
// (plans:audit, rubrics:propose, scorecards:evaluate) are steps of the
// plan-completion ship gate, and capability:read is prescribed by name in the
// repo's own bash-vs-tool routing table. If deferred discovery breaks, these
// are the tools agents lose.
import '../plans/audit';
import '../rubrics/propose';
import '../capability/read';
import '../scorecards/evaluate';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- generated .mjs data module, no type declarations.
import { CLAUDE_TOOL_DELIVERY } from '../../../../../apps/operator/scripts/tool-delivery.generated.mjs';

type ToolDef = {
  name: string;
  handler: (
    a: unknown,
    c?: unknown,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

type FindResult = {
  count: number;
  hits: Array<{ tool: string; description: string | null; argSchema: string | null }>;
};

const TIERS = CLAUDE_TOOL_DELIVERY.tiers as Record<string, 'full' | 'compact'>;

/** The artifact's own contract: "A name absent here is DEFERRED." */
const isDeferred = (name: string): boolean =>
  !Object.prototype.hasOwnProperty.call(TIERS, name);

/** Deferred, and each one load-bearing enough that losing it would matter. */
const PROBE_DEFERRED = [
  'plans:audit',
  'rubrics:propose',
  'capability:read',
  'scorecards:evaluate',
] as const;

/** Advertised control — proves the tier lookup itself resolves. */
const PROBE_ADVERTISED = 'tools:find';

/**
 * A name no tool has. Not arbitrary: an agent in the D-023 A/B invented this
 * one and dispatched it through tools:invoke.
 */
const FABRICATED = 'activity:tool-log';

async function findByIntent(query: string, limit = 12): Promise<FindResult> {
  const res = await (toolFind as unknown as ToolDef).handler({ query, limit }, {});
  return JSON.parse(res.content[0].text) as FindResult;
}

function corpusToolNames(): Set<string> {
  return new Set(buildCorpus().corpus.map((e) => e.tool));
}

beforeEach(() => {
  hiveMocks.potHomeSlugForHarness.mockReset();
  hiveMocks.potHomeSlugForHarness.mockResolvedValue(null);
  pluginHostMocks.getPluginHost.mockReset();
  pluginHostMocks.getPluginHost.mockResolvedValue({ loaded: [] });
});

describe('R-8 calibration — the probes are genuinely deferred', () => {
  it('CONTROL: an advertised tool resolves in the tier map, so "absent" means deferred', () => {
    // Without this, a failed artifact load would make EVERY name look deferred
    // and every assertion below would pass vacuously.
    expect(Object.keys(TIERS).length).toBeGreaterThan(0);
    expect(isDeferred(PROBE_ADVERTISED)).toBe(false);
    expect(TIERS[PROBE_ADVERTISED]).toBe('compact');
  });

  it('every probe tool is DEFERRED by the shipping seed', () => {
    // If a future seed promotes one of these, this fails and the probe set
    // must be re-picked — rather than the suite quietly testing advertised
    // tools and calling it deferred reachability.
    for (const name of PROBE_DEFERRED) {
      expect(isDeferred(name), `${name} is expected to be deferred`).toBe(true);
    }
  });

  it('deferral is the majority case, which is what makes this bar load-bearing', () => {
    expect(CLAUDE_TOOL_DELIVERY.counts.deferred).toBeGreaterThan(
      CLAUDE_TOOL_DELIVERY.counts.compact + CLAUDE_TOOL_DELIVERY.counts.full,
    );
  });
});

describe('R-8 discovery — the corpus is not limited to the advertised seed', () => {
  it('every deferred probe is present in the discovery corpus', () => {
    const names = corpusToolNames();
    for (const name of PROBE_DEFERRED) {
      expect(names.has(name), `${name} must be discoverable`).toBe(true);
    }
  });

  it('discovery is not filtered by delivery tier — deferred and advertised sit side by side', () => {
    // NOT an assertion about corpus SIZE. buildCorpus() reads the registry as
    // populated in THIS process, so a unit test sees only the tool modules it
    // (transitively) imported — measured at 37 here, which is smaller than the
    // 63-name advertised seed. Absolute size therefore measures the test's own
    // import graph, not the product.
    //
    // The property that IS meaningful, and that R-8 depends on, is that the
    // discovery corpus does not apply the delivery tier as a filter: a tool
    // being deferred must not remove it from search.
    const names = [...corpusToolNames()];
    const advertisedInCorpus = names.filter((n) => !isDeferred(n));
    const deferredInCorpus = names.filter(isDeferred);

    expect(advertisedInCorpus.length, 'control: advertised tools are in the corpus').toBeGreaterThan(0);
    expect(deferredInCorpus.length, 'the property: deferred tools are NOT filtered out').toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL: a fabricated name is absent, so corpus membership discriminates', () => {
    expect(corpusToolNames().has(FABRICATED)).toBe(false);
  });
});

describe('R-8 discovery — a deferred tool is found by INTENT, not by its name', () => {
  it('an intent query that never spells a tool name returns deferred tools', async () => {
    const query = 'check plan items against the real code and record citations';
    // The query must not leak a colon-form name, or this measures echo rather
    // than discovery.
    expect(query).not.toMatch(/[a-z_]+:[a-z_-]+/);

    const out = await findByIntent(query);
    expect(out.hits.length).toBeGreaterThan(0);

    const deferredHits = out.hits.filter((h) => isDeferred(h.tool));
    expect(
      deferredHits.length,
      `expected at least one DEFERRED tool among: ${out.hits.map((h) => h.tool).join(', ')}`,
    ).toBeGreaterThan(0);
  });

  it('a discovered deferred tool carries a usable argSchema, not just a name', async () => {
    // Reachability needs the CONTRACT: a name with no schema still forces the
    // caller to guess arguments, which is the malformed-call failure mode.
    const out = await findByIntent('propose an acceptance rubric for a plan');
    const hit = out.hits.find((h) => isDeferred(h.tool) && h.argSchema);
    expect(hit, 'no deferred hit carried an argSchema').toBeTruthy();
    expect((hit!.argSchema ?? '').length).toBeGreaterThan(0);
  });
});

describe('R-8 dispatch — tools:invoke reaches a deferred tool', () => {
  it('dispatches a deferred colon-form name verbatim', async () => {
    const calls: Array<[string, unknown]> = [];
    const ctx = {
      dispatchTool: vi.fn(async (name: string, a: unknown) => {
        calls.push([name, a]);
        return { content: [{ type: 'text', text: 'dispatched-ok' }], isError: false };
      }),
    };

    await (toolInvoke as unknown as ToolDef).handler(
      { name: 'plans:audit', args: { slug: 'some-plan' } },
      ctx,
    );

    expect(calls).toEqual([['plans:audit', { slug: 'some-plan' }]]);
  });

  it('END TO END: find by intent, then invoke the deferred name it returned', async () => {
    // This is the bar itself — the two legs composed, with nothing but an
    // intent sentence as input.
    const out = await findByIntent('check plan items against the real code and record citations');
    const discovered = out.hits.find((h) => isDeferred(h.tool));
    expect(discovered, 'discovery leg returned no deferred tool').toBeTruthy();

    const calls: Array<[string, unknown]> = [];
    const ctx = {
      dispatchTool: vi.fn(async (name: string, a: unknown) => {
        calls.push([name, a]);
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      }),
    };

    await (toolInvoke as unknown as ToolDef).handler(
      { name: discovered!.tool, args: {} },
      ctx,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(discovered!.tool);
    expect(isDeferred(calls[0][0])).toBe(true);
  });

  it('CHARACTERIZATION: dispatch does not validate existence — discovery is the guard', async () => {
    // Recorded deliberately. tools:invoke forwards whatever name it is given,
    // so nothing downstream stops a FABRICATED name; the only thing standing
    // between an agent and an invented tool is the discovery leg above. That
    // is why R-8 bars discovery end-to-end and not merely dispatch.
    const calls: Array<[string, unknown]> = [];
    const ctx = {
      dispatchTool: vi.fn(async (name: string, a: unknown) => {
        calls.push([name, a]);
        return { content: [{ type: 'text', text: 'forwarded' }], isError: false };
      }),
    };

    await (toolInvoke as unknown as ToolDef).handler({ name: FABRICATED, args: {} }, ctx);

    expect(calls[0][0]).toBe(FABRICATED);
    expect(corpusToolNames().has(FABRICATED)).toBe(false);
  });
});
