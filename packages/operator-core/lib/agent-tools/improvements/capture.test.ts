import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import captureTool from './capture';
import { coerceCaptureKind, coerceIdeateProvenance } from './capture-coerce';
import { captureImprovement } from '../../harness/improvements/capture-core';
import { noveltyPriorArt } from '../../scout/novelty-precheck';
import { resolveAgentIdentity } from '../coordination/identity';
import { recordRoutedIdea } from '../../scout/routed-ledger';
import { computeObservationsImpact } from '../../scout/observation-impact-leg';

// PG-free unit: capture-core has its own 31-test suite; this pins the tool
// wrapper's two jobs — (1) deriving the `source` label from the caller's
// identity tier, and (2) passing every arg + the resolved identity through to
// the shared core unchanged. (self-learning-central P-001/P-010.)
vi.mock('../../harness/improvements/capture-core');
vi.mock('../coordination/identity');
// P-008: the novelty pre-check is PG-backed (readNoveltyCorpus) — mock it so this
// suite stays PG-free. Default = resolved undefined ("check unavailable"), which the
// handler renders as an ABSENT priorArt field, leaving every pre-P-008 assertion
// byte-identical; the P-008 describe below sets explicit values.
vi.mock('../../scout/novelty-precheck', () => ({ noveltyPriorArt: vi.fn(async () => undefined) }));
// EI-10607: the su-ideate ledger write was PG-backed and entirely UNMOCKED here, so what
// capture passes to recordRoutedIdea was never asserted by any test — which is exactly where
// the bug lived (it never passed addressesPatternRefs, so no su idea could ever be counted as
// grounded). Mock it so the ledger row's CONTENTS are pinned, PG-free.
vi.mock('../../scout/routed-ledger', () => ({ recordRoutedIdea: vi.fn(async () => undefined) }));

const mockCapture = vi.mocked(captureImprovement);
const mockIdentity = vi.mocked(resolveAgentIdentity);
const mockPriorArt = vi.mocked(noveltyPriorArt);
const mockRecordRoutedIdea = vi.mocked(recordRoutedIdea);

function identity(source: ReturnType<typeof resolveAgentIdentity>['source'], ownerId = 'su-test') {
  return {
    ownerId,
    ownerLabel: `${source} · ${ownerId}`,
    source,
    workspaceId: 'ws-1',
    userId: null,
  } as ReturnType<typeof resolveAgentIdentity>;
}

function callTool(args: Record<string, unknown>, ctx: unknown = {}) {
  return (
    captureTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

describe('improvements:capture tool envelope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue(identity('omp-hook-session'));
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-1', created: true } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
  });

  it('maps an omp-hook-session caller to source="su"', async () => {
    mockIdentity.mockReturnValue(identity('omp-hook-session', 'su-abc'));
    await callTool({ title: 'flaky lock hook', kind: 'bug' });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ source: 'su', createdBy: 'su-abc' }));
  });

  it('maps a static-client caller to source="su"', async () => {
    mockIdentity.mockReturnValue(identity('static-client'));
    await callTool({ title: 'x', kind: 'bug' });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ source: 'su' }));
  });

  it('maps every other identity tier (e.g. fleet-spawn / principal) to source="engineer"', async () => {
    for (const src of ['fleet-spawn', 'principal', 'signed-spawn', 'power-user-token'] as const) {
      mockCapture.mockClear();
      mockIdentity.mockReturnValue(identity(src));
      await callTool({ title: 'x', kind: 'change' });
      expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ source: 'engineer' }));
    }
  });

  it('passes every arg + the resolved ownerId through to the core unchanged', async () => {
    mockIdentity.mockReturnValue(identity('static-client', 'su-owner'));
    await callTool({
      title: 'db-tooling friction',
      kind: 'change',
      body: 'repro steps',
      severity: 'major',
      subTopic: 'db-tooling',
      scope: 'harness:foo',
      foundDuring: 'WI-9',
      paths: ['a.ts', 'b.ts'],
      force: true,
      checkDuplicatesOnly: false,
      origin: 'drill',
    });
    expect(mockCapture).toHaveBeenCalledWith({
      title: 'db-tooling friction',
      kind: 'change',
      body: 'repro steps',
      severity: 'major',
      subTopic: 'db-tooling',
      scope: 'harness:foo',
      foundDuring: 'WI-9',
      paths: ['a.ts', 'b.ts'],
      force: true,
      checkDuplicatesOnly: false,
      origin: 'drill',
      createdBy: 'su-owner',
      source: 'su',
    });
  });

  it('returns the core result verbatim in the tool envelope', async () => {
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-42', created: true, duplicateOf: null } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
    const res = await callTool({ title: 'x', kind: 'bug' });
    const body = JSON.parse(res.content[0].text);
    expect(body).toEqual({ ok: true, id: 'EI-42', created: true, duplicateOf: null });
  });
});

describe('improvements:capture — observation strict/fail-loud (P-012)', () => {
  // The tool's args zod is the strip-or-reject boundary (the handler-direct tests above bypass it).
  // `.strict()` on the observation object makes an UNKNOWN key a LOUD arg-parse error instead of a
  // silent strip — the silent strip dropped data live (su-2a0b4: an Overwatch scorecard against the
  // not-yet-deployed schema persisted scope-only, no error). Tested via the exposed args zod.
  const argsSchema = (
    captureTool as unknown as {
      args: { safeParse: (v: unknown) => { success: boolean; error?: { issues: unknown[] } } };
    }
  ).args;

  it('accepts a known observation (kind/scope/confidence/refs)', () => {
    const r = argsSchema.safeParse({
      title: 'friction note',
      lane: 'observation',
      observation: { kind: 'friction', scope: 'self', confidence: 'high', refs: ['tool:foo'] },
    });
    expect(r.success).toBe(true);
  });

  it('accepts a rubric-graded observation (rubricRef + ratings with evidence)', () => {
    const r = argsSchema.safeParse({
      title: 'scorecard',
      lane: 'observation',
      observation: {
        rubricRef: 'pot-coordination-health',
        ratings: { placement: { rating: 'healthy', evidence: '0 stalls this wake' } },
      },
    });
    expect(r.success).toBe(true);
  });

  it('REJECTS an unknown observation field (was silently stripped — su-2a0b4) and names the key', () => {
    const r = argsSchema.safeParse({
      title: 'scorecard against a newer schema',
      lane: 'observation',
      observation: { kind: 'friction', bogusNewField: 'a field the deployed schema does not know' },
    });
    expect(r.success).toBe(false);
    // fail-loud: the rejection NAMES the unrecognized key (not a silent strip / no opaque pass)
    expect(JSON.stringify(r.success ? [] : r.error!.issues)).toContain('bogusNewField');
  });
});

/**
 * WI-1974 — improvements:capture (the self-improvement loop's OWN intake tool) failed
 * ~17% of calls, 29/34 on the top-level `kind` enum, and every reject LOSES the captured
 * insight. Live 48h failing-`kind` values: observation 18 · null 11 · process/tooling/
 * improvement/reliability/issue/tool-friction 9 · friction/gap 3. We coerce these to intent
 * BEFORE validation — never rejecting on `kind` — while leaving the DELIBERATE observation
 * `.strict()` key-rejection intact.
 */
describe('improvements:capture kind coercion (WI-1974)', () => {
  const parse = (x: unknown) => (captureTool.args as { parse: (v: unknown) => Record<string, unknown> }).parse(x);

  describe('coerceCaptureKind (unit)', () => {
    it('leaves a valid {bug,change,feature} kind untouched', () => {
      expect(coerceCaptureKind({ title: 't', kind: 'bug' })).toEqual({ title: 't', kind: 'bug' });
    });

    it('case-normalises a valid kind (BUG → bug) instead of rejecting', () => {
      expect(coerceCaptureKind({ title: 't', kind: 'BUG' })).toEqual({ title: 't', kind: 'bug' });
    });

    it('drops an explicit null kind so the schema default applies (the 11× null case)', () => {
      expect(coerceCaptureKind({ title: 't', kind: null })).toEqual({ title: 't' });
    });

    it("maps kind:'observation' → lane:'observation', dropping the bad kind (the 18× dominant case)", () => {
      expect(coerceCaptureKind({ title: 't', kind: 'observation' })).toEqual({ title: 't', lane: 'observation' });
    });

    it('maps an observation SUB-kind → lane:observation + observation.kind', () => {
      expect(coerceCaptureKind({ title: 't', kind: 'friction' })).toEqual({
        title: 't',
        lane: 'observation',
        observation: { kind: 'friction' },
      });
    });

    it('does not clobber a caller-provided observation.kind when mapping a sub-kind', () => {
      expect(coerceCaptureKind({ title: 't', kind: 'gap', observation: { kind: 'surprise', scope: 'self' } })).toEqual({
        title: 't',
        lane: 'observation',
        observation: { kind: 'surprise', scope: 'self' },
      });
    });

    it("maps a free-form label ('tooling','process','improvement','issue') → the default 'change'", () => {
      for (const label of ['tooling', 'process', 'improvement', 'reliability', 'issue', 'tool-friction']) {
        expect((coerceCaptureKind({ title: 't', kind: label }) as { kind: string }).kind).toBe('change');
      }
    });

    it('passes a non-object through untouched', () => {
      expect(coerceCaptureKind('x')).toBe('x');
      expect(coerceCaptureKind(null)).toBe(null);
    });
  });

  describe('through the real args schema (the wire shapes that 400ed now parse)', () => {
    it("kind:'observation' parses to lane:observation (was: kind Invalid option)", () => {
      const p = parse({ title: 'turn-end note', kind: 'observation' });
      expect(p.lane).toBe('observation');
      expect(p.kind).toBeUndefined();
    });

    it('kind:null parses (was: expected one of bug|change|feature)', () => {
      expect(() => parse({ title: 't', kind: null })).not.toThrow();
    });

    it("an observation sub-kind parses to a lane:observation record", () => {
      const p = parse({ title: 'hit a gap', kind: 'gap' });
      expect(p.lane).toBe('observation');
      expect(p.observation).toMatchObject({ kind: 'gap' });
    });

    it("a free-form label parses as kind:'change'", () => {
      expect(parse({ title: 'flaky tool', kind: 'tooling' }).kind).toBe('change');
    });

    it('a well-formed kind:bug is unaffected', () => {
      expect(parse({ title: 't', kind: 'bug' }).kind).toBe('bug');
    });

    it('STILL fails loud on an unknown observation key (the deliberate .strict() is preserved)', () => {
      expect(() => parse({ title: 't', lane: 'observation', observation: { kind: 'friction', bogus: 1 } })).toThrow();
    });
  });

  it('the published tools/list JSON schema still advertises kind as the {bug,change,feature} enum', () => {
    const json = z.toJSONSchema(captureTool.args as never) as {
      properties?: { kind?: { enum?: string[]; type?: string } };
    };
    expect(json.properties?.kind?.enum).toEqual(['bug', 'change', 'feature']);
  });
});

// EI-10424: an IDEATE-pass proposal left at kind:'change' (the ambiguous default)
// must be coerced into the reviewed kind:'feature' lane — never land as ordinary
// claimable change-work with no lane. Guard for the exact defect the bug reported.
describe('improvements:capture IDEATE-provenance coercion (EI-10424)', () => {
  const ideation = { lens: 'risk-first', bet: 'upside' };

  describe('coerceIdeateProvenance (unit)', () => {
    it("an ideation payload with kind omitted → kind:'feature'", () => {
      expect(coerceIdeateProvenance({ title: 't', ideation })).toEqual({ title: 't', ideation, kind: 'feature' });
    });

    it("an ideation payload with kind:'change' → kind:'feature'", () => {
      expect(coerceIdeateProvenance({ title: 't', kind: 'change', ideation })).toEqual({
        title: 't',
        kind: 'feature',
        ideation,
      });
    });

    it("foundDuring naming an ideate pass, no ideation payload → kind:'feature'", () => {
      expect(coerceIdeateProvenance({ title: 't', foundDuring: 'su-ideate pass 2026-07-12: memory frontier' })).toEqual({
        title: 't',
        foundDuring: 'su-ideate pass 2026-07-12: memory frontier',
        kind: 'feature',
      });
    });

    it('an unrelated foundDuring / no ideation signal is left untouched (stays change-default)', () => {
      expect(coerceIdeateProvenance({ title: 't', foundDuring: 'triaging the drain queue' })).toEqual({
        title: 't',
        foundDuring: 'triaging the drain queue',
      });
    });

    it("an EXPLICIT kind:'bug' found while ideating is never overridden (a real defect stays a bug)", () => {
      expect(coerceIdeateProvenance({ title: 't', kind: 'bug', foundDuring: 'su-ideate pass: audit' })).toEqual({
        title: 't',
        kind: 'bug',
        foundDuring: 'su-ideate pass: audit',
      });
    });

    it("lane:'observation' is never coerced (never enters the work queue regardless of kind)", () => {
      expect(coerceIdeateProvenance({ title: 't', lane: 'observation', ideation })).toEqual({
        title: 't',
        lane: 'observation',
        ideation,
      });
    });

    it('an empty ideation object (no lens/bet/cheapExperiment) is not a signal', () => {
      expect(coerceIdeateProvenance({ title: 't', ideation: {} })).toEqual({ title: 't', ideation: {} });
    });

    it('passes a non-object through untouched', () => {
      expect(coerceIdeateProvenance('x')).toBe('x');
    });
  });

  describe('through the real args schema — the exact EI-10424 defect shape', () => {
    const parse = (x: unknown) => (captureTool.args as { parse: (v: unknown) => Record<string, unknown> }).parse(x);

    it('an su-ideate capture with kind omitted parses to kind:feature, not the change default', () => {
      const p = parse({ title: 'idea', foundDuring: 'su-ideate: memory frontier', ideation });
      expect(p.kind).toBe('feature');
    });

    it('an su-ideate capture explicitly (mis)sent as kind:change is corrected to kind:feature', () => {
      const p = parse({ title: 'idea', kind: 'change', foundDuring: 'su-ideate: memory frontier', ideation });
      expect(p.kind).toBe('feature');
    });

    it('a genuine bug found during an ideate pass stays kind:bug (not coerced)', () => {
      const p = parse({ title: 'found a real bug', kind: 'bug', foundDuring: 'su-ideate pass: audit' });
      expect(p.kind).toBe('bug');
    });

    it('an ordinary change-work capture (no ideate provenance) is unaffected', () => {
      const p = parse({ title: 'bump a timeout', kind: 'change' });
      expect(p.kind).toBe('change');
    });
  });

  it('end-to-end: the coerced kind:feature makes the handler actually persist the ideation payload', async () => {
    mockIdentity.mockReturnValue(identity('omp-hook-session'));
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-1', created: true } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
    // Simulate the real wire path: parse through the schema (where coercion runs) THEN
    // hand the parsed args to the handler — callTool()/`.handler()` alone skips
    // z.preprocess, per the direct-handler tests above.
    const parsed = (captureTool.args as { parse: (v: unknown) => Record<string, unknown> }).parse({
      title: 'idea',
      foundDuring: 'su-ideate: memory frontier',
      ideation,
    });
    await callTool(parsed);
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ kind: 'feature', payloadExtra: { ideation } }));
  });
});

describe('improvements:capture — IDEATE-pass ideation persistence (su-ideate-learning-substrate P-007)', () => {
  const ideation = {
    lens: 'risk-first',
    bet: 'halves triage latency for su ideas',
    cheapExperiment: {
      hypothesis: 'triage decisions land twice as fast',
      method: 'measure one week of triage latency',
      falsifiableSignal: 'median triage latency unchanged',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue(identity('omp-hook-session'));
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-1', created: true } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
  });

  it("persists the declared ideation onto the created item's payload (payloadExtra.ideation) for a feature capture", async () => {
    await callTool({ title: 'su idea', kind: 'feature', ideation });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ payloadExtra: { ideation } }));
  });

  it('drops absent fields instead of persisting undefined keys', async () => {
    await callTool({ title: 'su idea', kind: 'feature', ideation: { bet: 'upside only' } });
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({ payloadExtra: { ideation: { bet: 'upside only' } } }),
    );
  });

  it('a non-feature kind never persists ideation (contract: ignored for non-feature kinds)', async () => {
    await callTool({ title: 'su idea', kind: 'change', ideation });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ payloadExtra: undefined }));
  });

  it('lane:observation never persists ideation', async () => {
    await callTool({ title: 'su idea', kind: 'feature', lane: 'observation', ideation });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ payloadExtra: undefined }));
  });

  it('an empty ideation object persists nothing (absence changes nothing, D-005)', async () => {
    await callTool({ title: 'su idea', kind: 'feature', ideation: {} });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ payloadExtra: undefined }));
  });
});

// ---------------------------------------------------------------------------
// EI-10607 — THE GROUNDING LEG. Before this, no su-reachable verb could write
// `addresses_pattern_refs`: capture never passed it and blender:route-idea never took it
// (only Scout's internal router did). So observationsImpact.ideasGrounded/shipped were pinned
// at 0 BY CONSTRUCTION — 122 su ideas, 0 grounded, against Scout's 24/24 — and the zero read
// to every agent as an honest "no impact yet".
//
// The load-bearing guard is the LAST one: it proves the metric CAN MOVE. Asserting only that
// recordRoutedIdea was called with the field would pin the plumbing and still tell us nothing
// about whether the funnel it feeds can ever report a nonzero.
// ---------------------------------------------------------------------------
describe('improvements:capture — the su-ideate GROUNDING leg (EI-10607)', () => {
  const patternRef = 'wi:EI-10587';

  beforeEach(() => {
    vi.clearAllMocks();
    // capture.ts maps the identity tier to its `source` label: only omp-hook-session /
    // static-client resolve to 'su', and ONLY an 'su' source writes the ideate ledger row.
    mockIdentity.mockReturnValue(identity('omp-hook-session'));
    mockCapture.mockResolvedValue({ ok: true, created: true, issue: { id: 'EI-900', title: 'su idea' } } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
  });

  it('records the declared pattern refs on the su-ideate ledger row', async () => {
    await callTool({
      title: 'su idea',
      kind: 'feature',
      ideation: { lens: 'risk-first', addressesPatternRefs: [patternRef] },
    });
    expect(mockRecordRoutedIdea).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'su-ideate', addressesPatternRefs: [patternRef] }),
    );
  });

  it('omits the key entirely when the caller grounds on nothing (row shape unchanged for an ungrounded filing)', async () => {
    await callTool({ title: 'su idea', kind: 'feature', ideation: { lens: 'risk-first' } });
    const arg = mockRecordRoutedIdea.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(arg).toBeDefined();
    expect('addressesPatternRefs' in arg).toBe(false);
  });

  it('THE METRIC CAN NOW MOVE: an idea filed with a citing pattern ref lands as `grounded` in observationsImpact — and without it, cannot', async () => {
    await callTool({
      title: 'su idea',
      kind: 'feature',
      ideation: { lens: 'risk-first', addressesPatternRefs: [patternRef] },
    });
    const written = mockRecordRoutedIdea.mock.calls[0][0] as {
      ideaId: string;
      routedRef: string;
      origin?: string;
      addressesPatternRefs?: string[];
    };

    // My observation, and the digest pattern whose exemplar ref cites it.
    const filings = [{ id: 'EI-10587', title: 'a recurring friction', filedAtMs: Date.now() }];
    const patterns = [{ ref: patternRef, summary: 'the pattern', category: 'capability-gap', weight: 0.67 }];
    const asLedgerRow = (refs: string[]) => ({
      ideaId: written.ideaId,
      routedRef: written.routedRef,
      origin: written.origin,
      outcome: 'won' as const,
      addressesPatternRefs: refs,
    });

    // Fed the row capture ACTUALLY writes, the funnel now reports the full arc.
    const after = computeObservationsImpact(filings, patterns, [asLedgerRow(written.addressesPatternRefs ?? [])]);
    expect(after.summary).toMatchObject({ filings: 1, surfacedAsPattern: 1, ideasGrounded: 1, shipped: 1 });
    expect(after.ideas[0]?.viaPatternRefs).toEqual([patternRef]);

    // The PRE-FIX row (capture wrote no refs) can never be counted, however good the idea —
    // this is the exact zero every su agent has been reading as "no impact yet".
    const before = computeObservationsImpact(filings, patterns, [asLedgerRow([])]);
    expect(before.summary).toMatchObject({ surfacedAsPattern: 1, ideasGrounded: 0, shipped: 0 });
  });
});

/**
 * P-008 (su-ideate-learning-substrate-2026-07-10): the REPORT-ONLY novelty
 * pre-check on the su kind:'feature' path. Pins the gate (su + feature +
 * improvement lane only), the response field semantics (array = checked, [] =
 * checked-and-clean, absent = not checked / check failed), and that a pre-check
 * failure NEVER fails the capture (D-005 — only the improvement-dedup declines).
 */
describe('IDEATE-pass novelty pre-check (P-008 priorArt)', () => {
  const A_MATCH = [
    { kind: 'idea', ref: 'wi:EI-77', title: 'the same idea, already dropped', similarity: 0.83, state: 'dropped' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue(identity('omp-hook-session'));
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-1', created: true } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
    mockPriorArt.mockResolvedValue([]);
  });

  async function bodyOf(args: Record<string, unknown>) {
    const res = await callTool(args);
    return JSON.parse(res.content[0].text) as Record<string, unknown>;
  }

  it("an su feature filing gets priorArt in the response, checked against the filing's title", async () => {
    mockPriorArt.mockResolvedValue(A_MATCH as Awaited<ReturnType<typeof noveltyPriorArt>>);
    const body = await bodyOf({ title: 'a fresh su idea', kind: 'feature' });
    expect(mockPriorArt).toHaveBeenCalledWith('a fresh su idea');
    expect(body.priorArt).toEqual(A_MATCH);
  });

  it('a clean check surfaces as priorArt: [] (checked, nothing similar) — distinct from absent', async () => {
    const body = await bodyOf({ title: 'a fresh su idea', kind: 'feature' });
    expect(body.priorArt).toEqual([]);
  });

  it('runs on a dedup-decline too (the collision report is MOST useful there)', async () => {
    mockCapture.mockResolvedValue({ ok: false, created: false, duplicateOf: 'EI-5' } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
    mockPriorArt.mockResolvedValue(A_MATCH as Awaited<ReturnType<typeof noveltyPriorArt>>);
    const body = await bodyOf({ title: 'a fresh su idea', kind: 'feature' });
    expect(body.priorArt).toEqual(A_MATCH);
  });

  it('non-feature kinds, the observation lane, and non-su callers are never checked', async () => {
    await callTool({ title: 'x', kind: 'change' });
    await callTool({ title: 'x', kind: 'bug' });
    await callTool({ title: 'x', kind: 'feature', lane: 'observation' });
    mockIdentity.mockReturnValue(identity('signed-spawn'));
    await callTool({ title: 'x', kind: 'feature' });
    expect(mockPriorArt).not.toHaveBeenCalled();
  });

  it('a pre-check failure NEVER fails the capture — the field is simply absent (report-only, D-005)', async () => {
    mockPriorArt.mockRejectedValue(new Error('corpus read exploded'));
    const body = await bodyOf({ title: 'a fresh su idea', kind: 'feature' });
    expect(body).toEqual({ ok: true, id: 'EI-1', created: true });
    expect('priorArt' in body).toBe(false);
  });
});

describe('improvements:capture — notExercised shorthand (rubric-system-improvements P-002)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue(identity('su-abc'));
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-9', created: true } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
  });

  it("expands each listed key to an idle:-tagged unknown and strips the shorthand from the stored observation", async () => {
    await callTool({
      title: 'scoped drill scorecard',
      lane: 'observation',
      observation: {
        rubricRef: 'su-agent-behavior',
        ratings: { 'recall-utilization': { rating: 'pass', evidence: 'one targeted search' } },
        notExercised: ['fleet-stewardship', 'engineering-discipline'],
      },
    });
    const passed = mockCapture.mock.calls[0]![0] as {
      payloadExtra?: { observation?: { ratings?: Record<string, { rating: string; evidence: string }>; notExercised?: unknown } };
    };
    const obs = passed.payloadExtra?.observation;
    expect(obs?.notExercised).toBeUndefined(); // stripped — stored payload stays pure ratings
    expect(obs?.ratings?.['recall-utilization']).toEqual({ rating: 'pass', evidence: 'one targeted search' });
    expect(obs?.ratings?.['fleet-stewardship']).toEqual({
      rating: 'unknown',
      evidence: 'idle: not exercised by this run.',
    });
    expect(obs?.ratings?.['engineering-discipline']).toEqual({
      rating: 'unknown',
      evidence: 'idle: not exercised by this run.',
    });
  });

  it('an explicit rating for a key ALSO listed in notExercised wins over the expansion', async () => {
    await callTool({
      title: 'conflicting shorthand',
      lane: 'observation',
      observation: {
        rubricRef: 'r',
        ratings: { wake: { rating: 'degraded', evidence: 'real signal' } },
        notExercised: ['wake'],
      },
    });
    const passed = mockCapture.mock.calls[0]![0] as {
      payloadExtra?: { observation?: { ratings?: Record<string, { rating: string; evidence: string }> } };
    };
    expect(passed.payloadExtra?.observation?.ratings?.wake).toEqual({ rating: 'degraded', evidence: 'real signal' });
  });

  it('the args schema accepts notExercised (strict observation object knows the key)', () => {
    const argsSchema = (
      captureTool as unknown as {
        args: { safeParse: (v: unknown) => { success: boolean } };
      }
    ).args;
    const r = argsSchema.safeParse({
      title: 'scoped scorecard',
      lane: 'observation',
      observation: { rubricRef: 'r', ratings: { a: { rating: 'pass', evidence: 'e' } }, notExercised: ['b'] },
    });
    expect(r.success).toBe(true);
  });
});
