/**
 * Named result views — the Design's falsifiable check, implemented as tests.
 *
 * Plan: named-result-views-schema-stable-recovery-capsules-with-proj-2026-08-14.
 * The Design states the acceptance bar in these words:
 *
 *   "request a known view on a deliberately oversized result and confirm the
 *    receipt reports applied:true with returnedChars under the declared budget
 *    and the exact declared field set; then request an unknown view name and
 *    confirm a loud failure listing valid names, not a full unprojected
 *    payload."
 *
 * Each of those clauses is a test below, named after the clause it discharges.
 */

import { describe, expect, it } from 'vitest';

import {
  NAMED_VIEWS,
  VIEW_ARG,
  VIEW_BUDGET_MARKER,
  applyNamedView,
  applyNamedViewToResult,
  describeNamedView,
  resolveNamedView,
  takeNamedViewFromArgs,
  viewNamesFor,
} from './named-views';
import type { ViewableResult } from './named-views';

/**
 * RECORDED SAMPLES — real payload shapes, read off live tool results on
 * 2026-08-18, not invented for the test. These are what make the seeded views
 * falsifiable: a view whose paths drift from the tool's actual output fails
 * `pins every seeded view against a recorded payload shape` below rather than
 * silently returning a near-empty capsule in production.
 */
const SAMPLE_PIPELINE_POSITION = {
  positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
  deployedSha: '4824a92bf8fce1097e3a6348c993306cc8c0c275',
  blockedOn: 'gate',
  gate: {
    stalled: true,
    consecutiveReds: 25,
    verdictStale: true,
    verdictStaleReasonCode: 'writer-starved',
    ownership: { workItem: 'WI-39450', claimState: 'held' },
  },
  changeInCandidate: { judgingContainsPath: false, missingReason: 'newer-commit' },
  nextAction: null,
  summary: 'WAITING AT GATE (nothing to do — this leg is advancing on its own).',
};

const SAMPLE_COORD_ORIENT = {
  self: {
    ownerId: 'su-42b2e04c-7d24-4a0b-b763-ab19ad5b3525',
    ownerLabel: 'su · su-42b2e',
  },
  recovery: {
    selfRecall: "sessions:search { session:'self', mode:'verbatim' }",
    selfSession: { sourceKind: 'codex', sessionId: '01a02fac-0b42-7873-b869-dc6ee6e88ff4' },
    control: {
      schemaVersion: 'ctrl-v1',
      generation: 3,
      state: {
        modes: ['auto'],
        loop: { active: true, intervalSec: 60 },
        wakeSource: 'loop',
        carry: 'warm',
        route: { kind: 'fleet', fleet: 'ox-alpha-sol-replacements-2026-08-23', role: 'member' },
        scope: { workspace: 'papercusp-workspace', harness: 'papercusp', plan: null, items: [] },
      },
      provenance: {
        source: 'harness_shared.session_briefs.control_state',
        ownerId: 'su-42b2e04c-7d24-4a0b-b763-ab19ad5b3525',
        updatedAt: '2026-08-23T17:33:39.744Z',
      },
      resync: {
        on: ['missing-base', 'schema-mismatch', 'generation-mismatch'],
        verb: 'coord:orient',
        args: { afterCompaction: true },
        rule: 'replace-full-never-merge-behind',
      },
      budget: { estimatedTokens: 175, maxTokens: 384 },
    },
    loop: { active: true, intervalSec: 60 },
    checkpoints: [
      {
        id: 'WI-39919',
        title: 'Adopt named result views on recovery-critical reads',
        body: 'Publish stable recovery views.',
        checkpoint: 'Captured the real afterCompaction payload; next edit the named-view registry.',
      },
    ],
  },
  me: {
    summary: {
      agents: 1,
      alive: 1,
      claims: 1,
      orphaned_claims: 0,
      stalled_claims: 0,
      monitoring: 1,
      waiting: 0,
      unanswered_directed: 0,
    },
    agents: [
      {
        agentId: 'su-42b2e04c-7d24-4a0b-b763-ab19ad5b3525',
        alive: true,
        sessionState: 'live',
        selfWake: 'loop',
        verdict: 'monitoring',
        fleet: 'ox-alpha-sol-replacements-2026-08-23',
        claims: 1,
        doing: 'WI-39919 Adopt named recovery views',
        isSelf: true,
      },
    ],
  },
  inbox: { summary: { total: 478, returned: 25, truncated: 260 } },
  instructionPrecedence: {
    schemaVersion: 'instruction-precedence-v1',
    watermark: 'af80f8b75c99c441753452c0',
    effectiveMission: {
      constraint: 'execute-fleet-plan-only',
      source: 'fleet:ox-alpha-sol-replacements-2026-08-23:member',
      explanation: 'Pull only work admitted by the fleet scope/spec.',
    },
  },
  codexLocks: {
    lockMode: 'manual',
    hookHealth: 'configured-unverified',
    runtimeProbed: false,
    ownerId: 'su-42b2e04c-7d24-4a0b-b763-ab19ad5b3525',
    hooksConfigured: true,
    generation: 1,
    reason: 'Hooks are configured, but this exact Codex owner has not produced a successful runtime decision yet.',
    effectiveInstruction: 'Before every file edit, explicitly call locks:acquire and release it.',
  },
};

const SAMPLE_WORK_ITEMS_GET = {
  ok: true,
  results: [
    {
      ok: true,
      id: 'WI-39401',
      workItem: {
        id: 'WI-39401',
        kind: 'feature',
        harness: 'papercusp',
        title: 'Named result views — schema-stable recovery capsules',
        state: 'open',
        assignee: 'su-659a7da9-428f-4c8d-b456-d66a6611c51d',
        lastProgressAt: '2026-08-23T17:40:39.626Z',
        updatedAt: '2026-08-23T17:33:57.511Z',
      },
      holder: {
        goalRef: 'WI-39401',
        goalText: null,
        assumptions: { count: 1, keys: ['launch-provenance'] },
        declaredAt: '2026-08-23 13:33:57.50878-04',
        stale: false,
        agreement: 'sole',
        competing: [],
      },
      checkpoint: '## Re-claimed after my own release',
      checkpointAgeMs: 106_146,
      checkpointUpdatedAtMs: 1_787_506_839_606,
    },
  ],
  counts: { ok: 1, failed: 0 },
};

const SAMPLE_PLANS_GET = {
  ok: true,
  results: [
    {
      ok: true,
      slug: 'named-result-views-schema-stable-recovery-capsules-with-proj-2026-08-14',
      harness: 'papercusp',
      frontmatter: { title: 'Named result views', slug: 'named-result-views', status: 'ready' },
      now: { state: '✅ PLAN GREENLIT — APPROVED 2026-08-18.', next: 'Work its open items.' },
      counts: { items: 1, decisions: 0, sections: 7 },
    },
  ],
};

const SAMPLES: Record<string, unknown> = {
  'dev:pipeline_position': SAMPLE_PIPELINE_POSITION,
  'coord:orient': SAMPLE_COORD_ORIENT,
  'work_items:get': SAMPLE_WORK_ITEMS_GET,
  'plans:get': SAMPLE_PLANS_GET,
};

describe('named result views — resolution', () => {
  it('resolves a registered name to a versioned spec', () => {
    const r = resolveNamedView('work_items:get', 'capsule');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.def.version).toBeGreaterThanOrEqual(1);
    expect(r.spec.pick).toEqual(r.def.fields);
    // The spec handed onward must be a COPY: a caller mutating it must not be
    // able to rewrite the registry for every later call in the process.
    r.spec.pick!.push('injected');
    expect(NAMED_VIEWS['work_items:get']!.capsule!.fields).not.toContain('injected');
  });

  it('unknown view name fails LOUDLY and lists the valid names (never a full payload)', () => {
    const r = resolveNamedView('work_items:get', 'no-such-view');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('unknown_view');
    // The failure must be self-correcting: every valid name present in the text.
    for (const valid of viewNamesFor('work_items:get')) {
      expect(r.error).toContain(valid);
    }
    expect(r.validNames).toEqual(viewNamesFor('work_items:get'));
    // And it must NOT be a fallback that quietly returns everything.
    expect(r.error).toMatch(/view_unknown/);
  });

  it('a version-stale view spelling fails loudly with the current names', () => {
    const r = resolveNamedView('work_items:get', 'capsule@v0');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('unknown_view');
    expect(r.error).toContain('capsule');
    expect(r.validNames).toEqual(viewNamesFor('work_items:get'));
  });

  it('a tool with no registered views says so instead of guessing', () => {
    const r = resolveNamedView('some:tool-with-no-views', 'capsule');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('no_views_for_tool');
    expect(r.validNames).toEqual([]);
    expect(r.error).toContain('projection');
  });

  it('a malformed view argument is rejected, not coerced', () => {
    for (const bad of [null, undefined, 42, {}, [], '', '   ']) {
      const r = resolveNamedView('work_items:get', bad);
      expect(r.ok, `expected ${JSON.stringify(bad)} to be rejected`).toBe(false);
      if (r.ok) continue;
      expect(r.code).toBe('malformed_view');
    }
  });
});

describe('named result views — the Design falsifiable check', () => {
  it('known view on a deliberately OVERSIZED result: applied, under budget, exact field set', () => {
    const resolved = resolveNamedView('work_items:get', 'capsule');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    // Deliberately oversized: a checkpoint far larger than the declared budget.
    const oversized = {
      ...SAMPLE_WORK_ITEMS_GET,
      results: [{ ...SAMPLE_WORK_ITEMS_GET.results[0], checkpoint: 'X'.repeat(50_000) }],
    };

    const { text, receipt } = applyNamedView(oversized, resolved);

    expect(receipt.applied).toBe(true);
    expect(receipt.view).toBe('capsule');
    expect(receipt.sourceChars).toBe(JSON.stringify(oversized).length);
    expect(receipt.sourceChars).toBeGreaterThan(receipt.returnedChars);
    // "returnedChars under the declared budget" — the budget is a guarantee.
    expect(receipt.returnedChars).toBeLessThanOrEqual(receipt.budgetChars);
    expect(text.length).toBe(receipt.returnedChars);
    // "the exact declared field set" — not a superset, not a subset.
    expect(receipt.fields).toEqual(resolved.def.fields);
    // Trimming must be self-announcing, never silent.
    expect(receipt.budgetEnforced).toBe(true);
    expect(receipt.charsBeforeBudget).toBeGreaterThan(receipt.budgetChars);
    expect(text).toContain(VIEW_BUDGET_MARKER.trim().slice(0, 20));
    expect(describeNamedView(receipt)).toContain('TRIMMED');
  });

  it('a result that FITS is not trimmed and says nothing about a budget', () => {
    const resolved = resolveNamedView('dev:pipeline_position', 'verdict');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const { text, receipt } = applyNamedView(SAMPLE_PIPELINE_POSITION, resolved);
    expect(receipt.applied).toBe(true);
    expect(receipt.budgetEnforced).toBeUndefined();
    expect(receipt.returnedChars).toBeLessThan(receipt.budgetChars);
    expect(text).not.toContain(VIEW_BUDGET_MARKER);
    expect(describeNamedView(receipt)).not.toContain('TRIMMED');

    // The capsule carries the fields that answer the question, and drops the rest.
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).toHaveProperty('blockedOn', 'gate');
    expect(parsed).not.toHaveProperty('deployedSha');
  });

  it('the version is what makes a capsule schema-stable across successors', () => {
    const a = resolveNamedView('plans:get', 'capsule');
    const b = resolveNamedView('plans:get', 'capsule');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Same name resolves to the same version + field set every time — that IS
    // the stability guarantee a cold successor relies on.
    expect(a.def.version).toBe(b.def.version);
    expect(a.def.fields).toEqual(b.def.fields);

    const r1 = applyNamedView(SAMPLE_PLANS_GET, a).receipt;
    const r2 = applyNamedView(SAMPLE_PLANS_GET, b).receipt;
    expect(r1.version).toBe(r2.version);
    expect(describeNamedView(r1)).toContain(`v${r1.version}`);
  });
});

describe('named result views — seeded registry integrity', () => {
  it('publishes recovery-critical and monitor on both recovery reads', () => {
    for (const tool of ['coord:orient', 'work_items:get']) {
      expect(viewNamesFor(tool)).toEqual(expect.arrayContaining(['recovery-critical', 'monitor']));
    }
  });

  it('recovery-critical capsules preserve the cold-successor anchors under budget', () => {
    const orientView = resolveNamedView('coord:orient', 'recovery-critical');
    const itemView = resolveNamedView('work_items:get', 'recovery-critical');
    expect(orientView.ok && itemView.ok).toBe(true);
    if (!orientView.ok || !itemView.ok) return;

    const longCheckpoint = 'checkpoint evidence '.repeat(200);
    const itemSample = {
      ...SAMPLE_WORK_ITEMS_GET,
      results: SAMPLE_WORK_ITEMS_GET.results.map((result) => ({
        ...result,
        checkpoint: longCheckpoint,
      })),
    };
    const orient = applyNamedView(SAMPLE_COORD_ORIENT, orientView);
    const item = applyNamedView(itemSample, itemView);
    expect(orient.receipt.unmatchedFields ?? []).toEqual([]);
    expect(item.receipt.unmatchedFields ?? []).toEqual([]);
    expect(orient.receipt.budgetEnforced).toBeUndefined();
    expect(item.receipt.budgetEnforced).toBeUndefined();
    expect(orient.receipt.returnedChars).toBeLessThanOrEqual(orient.receipt.budgetChars);
    expect(item.receipt.returnedChars).toBeLessThanOrEqual(item.receipt.budgetChars);

    const orientBody = JSON.parse(orient.text) as Record<string, unknown>;
    const itemBody = JSON.parse(item.text) as Record<string, unknown>;
    expect(orientBody).toHaveProperty('recovery.control.state.loop.active', true);
    expect(orientBody).toHaveProperty('recovery.checkpoints.0.id', 'WI-39919');
    expect(orientBody).toHaveProperty('codexLocks.lockMode', 'manual');
    expect(itemBody).toHaveProperty('results.0.holder.agreement', 'sole');
    expect(itemBody).toHaveProperty('results.0.checkpoint', longCheckpoint);
    expect(itemBody).toHaveProperty('results.0.checkpointAgeMs', 106_146);
  });

  it('monitor capsules expose freshness without carrying checkpoint prose', () => {
    const orientView = resolveNamedView('coord:orient', 'monitor');
    const itemView = resolveNamedView('work_items:get', 'monitor');
    expect(orientView.ok && itemView.ok).toBe(true);
    if (!orientView.ok || !itemView.ok) return;

    const noisyOrient = {
      ...SAMPLE_COORD_ORIENT,
      me: {
        ...SAMPLE_COORD_ORIENT.me,
        agents: SAMPLE_COORD_ORIENT.me.agents.map((agent) => ({
          ...agent,
          intent: 'unbounded live intent '.repeat(600),
          queued: Array.from({ length: 100 }, (_, index) => `WI-${index}`),
        })),
      },
    };
    const orientApplied = applyNamedView(noisyOrient, orientView);
    expect(orientApplied.receipt.budgetEnforced).toBeUndefined();
    expect(orientApplied.receipt.returnedChars).toBeLessThanOrEqual(orientApplied.receipt.budgetChars);

    const orient = JSON.parse(orientApplied.text) as Record<
      string,
      unknown
    >;
    const item = JSON.parse(applyNamedView(SAMPLE_WORK_ITEMS_GET, itemView).text) as Record<
      string,
      unknown
    >;
    expect(orient).toHaveProperty('me.summary.claims', 1);
    expect(orient).toHaveProperty('me.agents.0.sessionState', 'live');
    expect(orient).toHaveProperty('inbox.summary.total', 478);
    expect(orient).toHaveProperty('codexLocks.lockMode', 'manual');
    expect(orient).not.toHaveProperty('me.agents.0.intent');
    expect(orient).not.toHaveProperty('me.agents.0.queued');
    expect(orient).not.toHaveProperty('recovery.checkpoints');
    expect(item).toHaveProperty('results.0.holder.stale', false);
    expect(item).toHaveProperty('results.0.checkpointAgeMs', 106_146);
    expect(item).not.toHaveProperty('results.0.checkpoint');
  });

  /**
   * The guard the module comment promises. A seeded view is only useful if its
   * paths match the tool's REAL output; when they drift, `applyPick` reports
   * them unmatched and the capsule comes back near-empty — a silent failure in
   * production. This converts that into a red test.
   */
  it('pins every seeded view against a recorded payload shape', () => {
    for (const [tool, views] of Object.entries(NAMED_VIEWS)) {
      const sample = SAMPLES[tool];
      expect(sample, `no recorded sample for seeded tool ${tool} — add one`).toBeDefined();

      for (const name of Object.keys(views)) {
        const resolved = resolveNamedView(tool, name);
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) continue;

        const { receipt } = applyNamedView(sample, resolved);
        expect(
          receipt.unmatchedFields ?? [],
          `view ${tool}/${name} declares field(s) that match nothing in the recorded payload`,
        ).toEqual([]);
      }
    }
  });

  /**
   * NEGATIVE CONTROL for the guard above. If the shape check could not fail, it
   * would prove nothing — this pins that a genuinely wrong path IS reported.
   */
  it('negative control: a wrong path is reported unmatched, so the guard can fail', () => {
    const wrong = { ok: true as const, tool: 'x', name: 'bogus', def: {
      version: 1,
      fields: ['results[].definitelyNotAField'],
      budgetChars: 500,
      purpose: 'control',
    }, spec: { pick: ['results[].definitelyNotAField'] } };

    const { receipt } = applyNamedView(SAMPLE_WORK_ITEMS_GET, wrong);
    expect(receipt.unmatchedFields).toContain('results[].definitelyNotAField');
  });

  it('every seeded view declares a budget under the result-door result cap', () => {
    // Views exist to keep a capsule small enough that it never itself trips a
    // spill; a budget at or above the door's cap would defeat the purpose.
    const DOOR_RESULT_CHARS = 6000;
    for (const [tool, views] of Object.entries(NAMED_VIEWS)) {
      for (const [name, def] of Object.entries(views)) {
        expect(def.budgetChars, `${tool}/${name}`).toBeGreaterThan(0);
        expect(def.budgetChars, `${tool}/${name}`).toBeLessThan(DOOR_RESULT_CHARS);
        expect(def.fields.length, `${tool}/${name} declares no fields`).toBeGreaterThan(0);
        expect(def.purpose.length, `${tool}/${name} has no purpose line`).toBeGreaterThan(0);
        expect(def.version, `${tool}/${name}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('exposes the dispatch argument name', () => {
    expect(VIEW_ARG).toBe('view');
  });
});

describe('named result views — dispatch seam', () => {
  // Annotated as ViewableResult on purpose: an inferred literal has no `_meta`,
  // and since applyNamedViewToResult is <T extends ViewableResult> => T, the
  // receipt assertion below would not typecheck against the narrowed type.
  const wrap = (body: unknown): ViewableResult => ({
    content: [{ type: 'text' as const, text: JSON.stringify(body) }],
  });

  it('ADDITIVE: no view argument leaves args untouched and nothing runs', () => {
    const args = { id: 'WI-1', harness: 'papercusp' };
    const taken = takeNamedViewFromArgs(args, 'work_items:get');
    expect(taken.kind).toBe('none');
    if (taken.kind !== 'none') return;
    expect(taken.args).toEqual(args);
  });

  it('strips the view argument before the tool schema ever sees it', () => {
    const taken = takeNamedViewFromArgs(
      { id: 'WI-1', [VIEW_ARG]: 'capsule' },
      'work_items:get',
    );
    expect(taken.kind).toBe('view');
    if (taken.kind !== 'view') return;
    // Every tool schema is additionalProperties:false — an unstripped key is
    // rejected as unknown by the whole catalog.
    expect(VIEW_ARG in taken.args).toBe(false);
    expect(taken.args).toEqual({ id: 'WI-1' });
    expect(taken.resolved.name).toBe('capsule');
  });

  it('an unknown view surfaces as an error the caller can act on', () => {
    const taken = takeNamedViewFromArgs({ [VIEW_ARG]: 'nope' }, 'work_items:get');
    expect(taken.kind).toBe('error');
    if (taken.kind !== 'error') return;
    expect(taken.validNames).toEqual(viewNamesFor('work_items:get'));
    expect(taken.error).toContain('capsule');
  });

  it('passes a semantic view argument through for tools without result-view registrations', () => {
    const args = { [VIEW_ARG]: 'claims', scope: 'workspace' };
    const taken = takeNamedViewFromArgs(args, 'coord:roster');

    // coord:roster owns `view` as its lens selector. The dispatch-level named
    // result-view protocol must not turn that valid tool argument into a
    // view_unknown error before the handler runs.
    expect(taken).toEqual({ kind: 'none', args });
  });

  /**
   * THE PARITY GUARANTEE. The previous generation of this seam was two
   * hand-mirrored copies of the projection logic, and the nested `tools:invoke`
   * path silently fell behind the direct one. Routing both through ONE function
   * makes divergence impossible — this pins that property.
   */
  it('nested and direct dispatch resolve a view identically (parity by construction)', () => {
    const argsDirect = { id: 'WI-39401', [VIEW_ARG]: 'capsule' };
    const argsNested = { id: 'WI-39401', [VIEW_ARG]: 'capsule' };

    const direct = takeNamedViewFromArgs(argsDirect, 'work_items:get');
    const nested = takeNamedViewFromArgs(argsNested, 'work_items:get');
    expect(direct.kind).toBe('view');
    expect(nested.kind).toBe('view');
    if (direct.kind !== 'view' || nested.kind !== 'view') return;

    expect(direct.args).toEqual(nested.args);
    expect(direct.resolved.def).toEqual(nested.resolved.def);

    const a = applyNamedViewToResult(wrap(SAMPLE_WORK_ITEMS_GET), direct.resolved);
    const b = applyNamedViewToResult(wrap(SAMPLE_WORK_ITEMS_GET), nested.resolved);
    expect(a).toEqual(b);
  });

  it('attaches the receipt to _meta and an in-band footer to the body', () => {
    const resolved = resolveNamedView('work_items:get', 'capsule');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const out = applyNamedViewToResult(wrap(SAMPLE_WORK_ITEMS_GET), resolved);
    const receipt = (out._meta as {
      namedView?: {
        view?: string;
        version?: number;
        applied?: boolean;
        sourceChars?: number;
        returnedChars?: number;
        fields?: string[];
      };
    }).namedView;
    expect(receipt?.view).toBe('capsule');
    expect(receipt?.version).toBe(resolved.def.version);
    expect(receipt?.applied).toBe(true);
    expect(receipt?.sourceChars).toBe(JSON.stringify(SAMPLE_WORK_ITEMS_GET).length);
    expect(receipt?.returnedChars).toBeGreaterThan(0);
    expect(receipt?.fields).toEqual(resolved.def.fields);

    const text = (out.content[0] as { text: string }).text;
    // The footer is the copy the agent actually reads.
    expect(text).toContain('view "capsule"');
    // And the capsule dropped what the view does not declare.
    expect(text).toContain('WI-39401');
    expect(text).not.toContain('"kind"');
  });

  it('FAIL-SOFT: a non-JSON body stays intact and carries an unapplied receipt', () => {
    const resolved = resolveNamedView('work_items:get', 'capsule');
    if (!resolved.ok) return;
    const original: ViewableResult = {
      content: [{ type: 'text' as const, text: 'not json at all' }],
    };
    const out = applyNamedViewToResult(original, resolved);
    expect((out.content[0] as { text: string }).text).toContain('not json at all');
    expect((out.content[0] as { text: string }).text).toContain('did NOT apply');
    expect(out._meta?.namedView).toMatchObject({
      view: 'capsule',
      version: resolved.def.version,
      applied: false,
      sourceChars: 'not json at all'.length,
      returnedChars: 'not json at all'.length,
      fields: resolved.def.fields,
    });
  });

  it('FAIL-SOFT: an error envelope is preserved and carries an unapplied receipt', () => {
    const resolved = resolveNamedView('work_items:get', 'capsule');
    if (!resolved.ok) return;
    const errEnvelope: ViewableResult = {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify({ results: [] }) }],
    };
    const out = applyNamedViewToResult(errEnvelope, resolved);
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain('{"results":[]}');
    expect(out._meta?.namedView).toMatchObject({
      view: 'capsule',
      version: resolved.def.version,
      applied: false,
      sourceChars: JSON.stringify({ results: [] }).length,
      returnedChars: JSON.stringify({ results: [] }).length,
      fields: resolved.def.fields,
    });
  });
});
