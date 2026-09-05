/**
 * EI-10952 (facts:assert silently truncated a >500-char body and returned a clean ok:true)
 * and EI-10948 (facts:list returned 50 × 500-char bodies ≈ 56k chars and blew the
 * tool-output budget).
 *
 * Both are the same defect in different clothes: the tool KNEW something the caller needed
 * (your write was lossy / this read is huge) and said nothing.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import assertTool, { truncationField, dependsOnSuggestionField } from './assert';
import { __resetCellRegistryForTests, registerCell } from '../../cell-registry';
import factsListTool, {
  FACTS_LIST_EXCERPT_NOTE,
  projectFact,
  isLiveFact,
  findLiveFactVersion,
  FACTS_LIST_EXCERPT_CHARS,
  FACTS_LIST_DEFAULT_LIMIT,
  FACTS_LIST_ALL_LIMIT,
  FACTS_LIST_MAX_LIMIT,
  clampFactsListLimit,
  factsListEffectiveLimit,
  factsListLimitDisclosure,
  factSlotAliasCandidates,
  selectFactKeyMatch,
} from './list';
import { clampFactBody, FACT_BODY_MAX_CHARS, type AgentFact } from '../../agent-facts/store';
import { CHARS_PER_TOKEN_ESTIMATE } from '../../context-doors';
import { RESULT_DOOR_TOKENS } from '../../result-door';

type AssertSchemaField = {
  description?: string;
  safeParse(value: unknown): { success: boolean };
};

beforeAll(() => {
  __resetCellRegistryForTests();
  registerCell({
    cell: 'git.pipelinePosition',
    owner: 'test',
    headline: 'positions.deployed',
    // Event-signalled ⇒ `null` is the required answer (D-016): no resolver payload to
    // read a code out of, so a non-null assessment would be refused.
    assessment: null,
    nullable: false,
    whyTotal: 'test fixture — the stub resolver returns a value or throws; no read can fail into a default.',
    callerRelativity: { kind: 'parameter', param: 'path' },
    provenance: { obtainedBy: 'test', liveExercised: true, evidence: 'test' },
    resolver: 'test resolver',
    visibility: { kind: 'workspace' },
    federation: { kind: 'local' },
    changeSignal: { kind: 'event', key: 'test' },
    shape: 'PipelinePosition',
  });
});

const assertSchemaField = (name: string): AssertSchemaField => {
  // EI-22064465906366039: the root union is retired, so `.options` (its branch
  // list) is gone. Unlike the other schema-reading tests, THIS file needs the
  // real zod field — it calls .safeParse on it below, and it asserts the zod
  // `.description`, which is NOT the same string the JSON-Schema projection
  // publishes for `body`. So unwrap the refinement chain to the object shape
  // rather than reading the projection.
  let node = assertTool.args as unknown as {
    shape?: Record<string, unknown>;
    def?: { schema?: unknown; innerType?: unknown };
    _def?: { schema?: unknown; innerType?: unknown };
  };
  for (let hop = 0; hop < 8 && !node.shape; hop += 1) {
    const inner = node.def?.schema ?? node.def?.innerType ?? node._def?.schema ?? node._def?.innerType;
    if (!inner) break;
    node = inner as typeof node;
  }
  const field = node.shape?.[name];
  if (!field) throw new Error(`facts:assert schema field missing: ${name}`);
  return field as AssertSchemaField;
};

const fact = (body: string, extra: Partial<AgentFact> = {}): AgentFact => ({
  scope: 'harness',
  scopeRef: 'papercusp',
  key: 'k',
  body,
  confidence: null,
  // P-008 (b), migration 690.
  kind: null,
  dependsOn: [],
  claim: null,
  // P-018 / D-016, migration 692. Null is the honest default here: this fixture
  // asserts DISCLOSURE of body truncation, not convention enforcement.
  enforcement: null,
  sourceRef: 'wi:EI-10951',
  audienceScope: null,
  sourceProvenance: null,
  createdBy: 'su-test',
  updatedAt: '2026-07-13T00:00:00Z',
  expiresAt: '2026-07-20T00:00:00Z',
  ...extra,
});

it('opts out of the ambient workspace transaction because facts:list uses dedicated org-pool reads', () => {
  expect((factsListTool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
});

describe('clampFactBody — boundary-aware clip (cold-carry-system-hardening-2026-07-19 P-004)', () => {
  it('clips at the last sentence boundary and marks the elision, never mid-sentence', () => {
    // EI-18681984560352579 / mig 664: parametric on FACT_BODY_MAX_CHARS (1200) —
    // repeat the sentence enough times to clear the cap regardless of its value.
    const sentences = `${'Front-loaded operative clause stays intact. '.repeat(40)}${'x'.repeat(200)}`;
    const out = clampFactBody(sentences);
    expect(out.length).toBeLessThanOrEqual(FACT_BODY_MAX_CHARS);
    expect(out.endsWith(' […]')).toBe(true);
    // The kept text ends exactly at a sentence end — no half-word, no half-clause.
    expect(out.slice(0, -' […]'.length).endsWith('.')).toBe(true);
  });

  it('falls back to a word boundary when no sentence boundary is late enough', () => {
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
    const out = clampFactBody(words);
    expect(out.length).toBeLessThanOrEqual(FACT_BODY_MAX_CHARS);
    expect(out.endsWith(' […]')).toBe(true);
    expect(out.slice(0, -' […]'.length)).not.toMatch(/\s$/);
    // No clipped half-word: the char before the marker is a word end from the input.
    const kept = out.slice(0, -' […]'.length);
    expect(words.startsWith(kept)).toBe(true);
    expect(words[kept.length]).toBe(' ');
  });

  it('degrades to the old hard cut for a boundary-free body (nothing to anchor on)', () => {
    const out = clampFactBody('z'.repeat(FACT_BODY_MAX_CHARS + 300));
    expect(out).toBe(`${'z'.repeat(FACT_BODY_MAX_CHARS - 1)}…`);
  });

  it('leaves an under-cap body untouched', () => {
    expect(clampFactBody('short and complete.')).toBe('short and complete.');
  });
});

/**
 * P-007 — the dependsOn suggestion, at the WIRING seam.
 *
 * The matcher's own precision guards are proven next door in
 * cell-transcription-detector.test.ts. THIS block exists because a correct matcher wired
 * to nothing emits nothing, and both halves look identical from a green unit suite —
 * the same gap that made P-006's boundary-only tests unable to see a written value.
 */
describe('dependsOnSuggestionField — facts:assert suggests the dependency the body implies (P-007)', () => {
  const TRANSCRIBING = 'main is 3 commits behind staging right now';

  it('returns null on the clean path — no field at all when nothing is transcribed', () => {
    // The whole-file convention: an advisory costs nothing on the common path.
    expect(dependsOnSuggestionField('a fact with no live values in it', [])).toBeNull();
  });

  it('suggests the cell and carries the evidence that produced it', () => {
    const out = dependsOnSuggestionField(TRANSCRIBING, [])!;
    expect(out).not.toBeNull();
    expect(out.suggested.map((s) => s.cell)).toContain('git.pipelinePosition');
    expect(TRANSCRIBING).toContain(out.suggested[0].value);
  });

  it('does not emit a bare accept for a caller-relative suggestion — it marks the result incomplete', () => {
    // The failure this pins: emitting git.pipelinePosition as a bare string lets an
    // obedient caller re-assert successfully while recording insufficient-data because
    // the required path subject was missing. A field that looks accept-ready but cannot
    // arm staleness is worse than an explicit incomplete result.
    const out = dependsOnSuggestionField(TRANSCRIBING, ['deploy.3070.sha'])!;
    expect(out.accept).toBeUndefined();
    expect(out.incomplete).toEqual([
      {
        cell: 'git.pipelinePosition',
        required: 'path',
        reason: 'caller-relative-subject-required',
      },
    ]);
    expect(out.note).toMatch(/incomplete suggestion/i);
  });

  it('says plainly that nothing was attached, so the caller is not left guessing', () => {
    const out = dependsOnSuggestionField(TRANSCRIBING, [])!;
    expect(out.note).toMatch(/NOTHING was attached or changed/);
  });

  it('stays silent when the caller already declared the cell', () => {
    expect(dependsOnSuggestionField(TRANSCRIBING, ['git.pipelinePosition'])).toBeNull();
  });
});

describe('truncationField — droppedTail echo (P-004)', () => {
  it('echoes the dropped tail verbatim so the caller can re-assert without reconstructing', () => {
    const raw = `${'Keep this sentence. '.repeat(70)}THE OPERATIVE TAIL THAT GOT CUT.`;
    const stored = clampFactBody(raw);
    const t = truncationField(raw, stored);
    expect(t?.droppedTail).toBeDefined();
    expect(t?.droppedTail).toContain('THE OPERATIVE TAIL');
  });

  it('clips a huge dropped tail to the echo cap', () => {
    const raw = `${'a sentence here. '.repeat(70)}${'t'.repeat(1000)}`;
    const stored = clampFactBody(raw);
    const t = truncationField(raw, stored);
    expect(t?.droppedTail?.length).toBeLessThanOrEqual(240);
  });

  it('hard-cut fallback still yields a tail (prefix ends with …)', () => {
    const raw = 'q'.repeat(FACT_BODY_MAX_CHARS + 300);
    const stored = clampFactBody(raw); // (FACT_BODY_MAX_CHARS - 1) q's + …
    const t = truncationField(raw, stored);
    expect(t?.droppedTail).toBeDefined();
    expect(t?.droppedTail?.startsWith('q')).toBe(true);
  });
});

describe('truncationField — facts:assert must not report a lossy write as clean (EI-10952)', () => {
  it('returns undefined when the body was stored intact (no field on the clean path)', () => {
    expect(truncationField('a short conclusion', 'a short conclusion')).toBeUndefined();
  });

  it('reports storedChars + droppedChars when the store truncated the body', () => {
    const raw = 'x'.repeat(647);
    const stored = `${'x'.repeat(499)}…`; // what clampFactBody actually persists
    const t = truncationField(raw, stored);
    expect(t).toBeDefined();
    expect(t?.storedChars).toBe(500);
    expect(t?.droppedChars).toBe(147);
  });

  it('the note explains WHY a truncated fact is worse than a clipped note — it folds verbatim as binding context', () => {
    const t = truncationField('y'.repeat(1181), `${'y'.repeat(499)}…`);
    expect(t?.note).toMatch(/VERBATIM/i);
    expect(t?.note).toMatch(/re-assert/i);
    // and it must NOT claim the write was lost — truncate-not-reject (P-007) is deliberate.
    expect(t?.note).toMatch(/KEPT/i);
  });

  it('ignores surrounding whitespace the store trims, rather than reporting a phantom truncation', () => {
    expect(truncationField('  hello  ', 'hello')).toBeUndefined();
  });
});

describe('projectFact — facts:list must stay inside the output budget (EI-10948)', () => {
  it('clamps explicit page sizes to the result-door-safe ceiling and discloses the clamp', () => {
    expect(clampFactsListLimit()).toBe(FACTS_LIST_DEFAULT_LIMIT);
    expect(clampFactsListLimit(1)).toBe(1);
    expect(clampFactsListLimit(FACTS_LIST_MAX_LIMIT)).toBe(FACTS_LIST_MAX_LIMIT);
    expect(clampFactsListLimit(100)).toBe(FACTS_LIST_MAX_LIMIT);
    expect(factsListLimitDisclosure(FACTS_LIST_MAX_LIMIT)).toBeUndefined();
    expect(factsListLimitDisclosure(100)).toEqual({
      limitCapped: { requested: 100, applied: FACTS_LIST_MAX_LIMIT, reason: 'result_door_budget' },
    });
  });

  it('provides a wider page escape hatch independent of body projection, without promising completeness', () => {
    expect(factsListEffectiveLimit(1, true)).toBe(FACTS_LIST_ALL_LIMIT);
    expect(factsListEffectiveLimit(100, true)).toBe(FACTS_LIST_ALL_LIMIT);
    expect(factsListEffectiveLimit(100, false)).toBe(FACTS_LIST_MAX_LIMIT);
    // RETARGETED (was /complete live population/i, stranded by d7e86d7d4f on
    // 2026-09-05). `all:true` is a PAGE ceiling, not the per-scope cap, so the
    // old wording promised a completeness this argument never delivered — the
    // file's own header records that "population" was false for the busiest
    // scope on the box. Assert the CORRECTED, stronger contract rather than
    // dropping the doc-claim: the description must still disclaim completeness
    // and must still point the reader at the response fields that settle it.
    expect(factsListTool.args.shape.all.description).toMatch(/not a guarantee of completeness/i);
    expect(factsListTool.args.shape.all.description).toMatch(/truncatedByLimit/);
    expect(factsListTool.args.shape.all.description).toMatch(/Orthogonal to full:true/);
  });

  it('excerpts a long body and says so, instead of returning 500 chars per row', () => {
    const row = projectFact(fact('z'.repeat(500)), false);
    expect(String(row.body)).toHaveLength(FACTS_LIST_EXCERPT_CHARS + 1); // + the '…'
    expect(row.body_truncated).toBe(true);
    expect(row.body_full_chars).toBe(500);
  });

  it('leaves a short body alone (no phantom truncation markers)', () => {
    const row = projectFact(fact('short'), false);
    expect(row.body).toBe('short');
    expect(row.body_truncated).toBeUndefined();
    expect(row.body_full_chars).toBeUndefined();
  });

  it('full:true returns the verbatim body — the escape hatch for when you need the real text', () => {
    const row = projectFact(fact('z'.repeat(500)), true);
    expect(String(row.body)).toHaveLength(500);
    expect(row.body_truncated).toBeUndefined();
  });

  it('keeps an unresolved typed source visibly unverified without copying a quote into the default row', () => {
    const row = projectFact(
      fact('Park, then just run it', {
        sourceRef: 'owner-turn',
        sourceProvenance: {
          kind: 'owner-turn',
          verified: false,
          error: 'owner_turn_unresolved',
          quote: 'a forged quote that must not become default context',
          label: 'forged label',
          verifiedAt: '2026-08-27T00:00:00.000Z',
        },
      }),
      false,
    );
    expect(row.sourceProvenance).toEqual({
      kind: 'owner-turn',
      verified: false,
      error: 'owner_turn_unresolved',
    });
    expect(JSON.stringify(row)).not.toContain('forged quote');
    expect(JSON.stringify(row)).not.toContain('forged label');
  });

  it('keeps verified provenance quote omission and exposes the full stamp only with full:true', () => {
    const sourceProvenance = {
      kind: 'msg' as const,
      verified: true,
      quote: 'the verified origin',
      label: 'msg m-1',
      verifiedAt: '2026-08-27T00:00:00.000Z',
    };
    const bounded = projectFact(fact('short', { sourceRef: 'msg:m-1', sourceProvenance }), false);
    expect(bounded.sourceProvenance).toBeUndefined();
    expect(projectFact(fact('short', { sourceRef: 'msg:m-1', sourceProvenance }), true).sourceProvenance).toEqual(
      sourceProvenance,
    );
  });

  it('NEVER excerpts away the staleness flag — it is the reason you are reading the list', () => {
    const stale = {
      sourceItem: 'EI-10539',
      sourceItemState: 'resolved',
      note: 'may be stale',
    };
    const row = projectFact({ ...fact('z'.repeat(500)), sourceStale: stale }, false);
    expect(row.stale).toEqual(stale);
  });

  it('a default-limit page of worst-case facts fits the universal result door', () => {
    // The live failure: 25 excerpted rows still exceeded the ~1500-token door and the
    // caller received a JSON body cut before its closing brace (EI-20242506233119355).
    const rows = Array.from({ length: FACTS_LIST_DEFAULT_LIMIT }, () =>
      projectFact(fact('z'.repeat(500)), false),
    );
    const payload = {
      ok: true,
      count: rows.length,
      excerpted: true,
      note: FACTS_LIST_EXCERPT_NOTE,
      facts: rows,
    };
    const serialized = JSON.stringify(payload);
    expect(serialized).toMatch(/^\{[\s\S]*\}$/);
    expect(serialized.length).toBeLessThan(RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE);
  });

  it('keeps the default page bounded when every row carries live metadata', () => {
    // EI-20245738587790330: the eight-row default passed the synthetic body-only
    // fixture but overflowed on staging facts whose rows also carried stale-source,
    // audience, claim, and dependency metadata.
    const rows = Array.from({ length: FACTS_LIST_DEFAULT_LIMIT }, (_, index) =>
      projectFact(
        {
          ...fact('z'.repeat(500), {
            key: `metadata-${index}`,
            audienceScope: 'fleet:nonp2p-bug-drain-luna-max-0811',
            confidence: 'verified',
            kind: 'conclusion',
            claim: { subject: 'pipeline.gate', assertion: 'green' },
            dependsOn: [
              {
                cell: 'pipeline.gate',
                observedAt: '2026-08-12T11:00:00.000Z',
                digest: 'a'.repeat(64),
                observed: 'green',
              },
            ],
          }),
          sourceStale: {
            sourceItem: 'EI-20245738587790330',
            sourceItemState: 'done',
            note: 'source item is terminal; this fact may be stale and should be rechecked before relying on it.',
          },
        },
        false,
      ),
    );
    const serialized = JSON.stringify({
      ok: true,
      count: rows.length,
      excerpted: true,
      note: FACTS_LIST_EXCERPT_NOTE,
      facts: rows,
    });
    expect(serialized).toMatch(/^\{[\s\S]*\}$/);
    expect(serialized.length).toBeLessThan(RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE);
  });
});

describe('facts:list key lookup — distinguish projection omission from live absence (EI-19437221871431967)', () => {
  const nowMs = Date.parse('2026-08-12T00:00:00.000Z');

  it('accepts a permanent or future-expiring current version', () => {
    expect(
      isLiveFact(
        { expiresAt: 'infinity', retractedAt: null, supersededAt: null },
        nowMs,
      ),
    ).toBe(true);
    expect(
      isLiveFact(
        { expiresAt: '2026-08-12T00:00:01.000Z', retractedAt: null, supersededAt: null },
        nowMs,
      ),
    ).toBe(true);
  });

  it('rejects expired, retracted, and superseded versions', () => {
    expect(
      isLiveFact(
        { expiresAt: '2026-08-11T23:59:59.000Z', retractedAt: null, supersededAt: null },
        nowMs,
      ),
    ).toBe(false);
    expect(
      isLiveFact(
        { expiresAt: '2026-08-13T00:00:00.000Z', retractedAt: '2026-08-11T00:00:00.000Z', supersededAt: null },
        nowMs,
      ),
    ).toBe(false);
    expect(
      isLiveFact(
        { expiresAt: '2026-08-13T00:00:00.000Z', retractedAt: null, supersededAt: '2026-08-11T00:00:00.000Z' },
        nowMs,
      ),
    ).toBe(false);
  });

  it('never falls back to an older historical version when the newest row is not live', () => {
    const old = fact('old', { expiresAt: '2026-08-13T00:00:00.000Z', supersededAt: '2026-08-11T00:00:00.000Z' });
    const expiredCurrent = fact('current', { expiresAt: '2026-08-11T23:59:59.000Z', supersededAt: null });
    expect(findLiveFactVersion([expiredCurrent, old], nowMs)).toBeUndefined();
  });

  it('documents that key without versions performs a direct live read', () => {
    const description = factsListTool.args.shape.key.description ?? '';
    expect(description).toMatch(/without versions/i);
    expect(description).toMatch(/ONE live fact/i);
  });

  it('expands an unprefixed assert key across the typed fact slots', () => {
    expect(factSlotAliasCandidates('same-key')).toEqual([
      'dead-end:same-key',
      'wall:same-key',
      'guard-rail:same-key',
    ]);
  });

  it('keeps already-prefixed key lookup exact', () => {
    expect(factSlotAliasCandidates('guard-rail:same-key')).toEqual([]);
    expect(factSlotAliasCandidates('WALL:same-key')).toEqual([]);
  });

  it('resolves exactly one live typed-slot alias', () => {
    const guardRail = fact('guard', { key: 'guard-rail:same-key' });
    expect(
      selectFactKeyMatch('same-key', undefined, [
        { key: 'dead-end:same-key', fact: undefined },
        { key: 'guard-rail:same-key', fact: guardRail },
      ]),
    ).toEqual({ kind: 'match', key: 'guard-rail:same-key', fact: guardRail });
  });

  it('reports multiple live slots as ambiguous instead of guessing or returning absent', () => {
    expect(
      selectFactKeyMatch('same-key', undefined, [
        { key: 'wall:same-key', fact: fact('wall', { key: 'wall:same-key' }) },
        { key: 'guard-rail:same-key', fact: fact('guard', { key: 'guard-rail:same-key' }) },
      ]),
    ).toEqual({ kind: 'ambiguous', keys: ['wall:same-key', 'guard-rail:same-key'] });
  });
});

describe('facts:assert body schema — declared vs enforced cap must not mislead the caller (EI-18670525043445474)', () => {
  it('front-loads the REAL storage cap (FACT_BODY_MAX_CHARS) in the body description, not just the 4000 transport ceiling', () => {
    const description = assertSchemaField('body').description ?? '';
    // The real, enforced cap must appear EARLY (before "documents" in the closing
    // clause) — a caller reading only the start of a long description must still
    // see it, not just the bare `maxLength: 4000` in the JSON-schema shape.
    expect(description).toContain(`HARD-CLIPPED AT ${FACT_BODY_MAX_CHARS} CHARS`);
    const hardClipIdx = description.indexOf(String(FACT_BODY_MAX_CHARS));
    expect(hardClipIdx).toBeGreaterThanOrEqual(0);
    expect(hardClipIdx).toBeLessThan(40); // front-loaded, not buried at the end
  });

  it('the schema still ACCEPTS a body past FACT_BODY_MAX_CHARS (up to the 4000 transport ceiling) — never hard-rejects a real conclusion (P-007 regression guard)', () => {
    const over500 = 'x'.repeat(FACT_BODY_MAX_CHARS + 200);
    const result = assertSchemaField('body').safeParse(over500);
    expect(result.success).toBe(true); // accepted, NOT rejected — clampFactBody truncates it downstream
  });

  it('the schema still REJECTS a body past the 4000 transport ceiling (the genuine hard limit)', () => {
    const wayOver = 'x'.repeat(4001);
    const result = assertSchemaField('body').safeParse(wayOver);
    expect(result.success).toBe(false);
  });
});

describe('facts:assert measurement schema — measuredAt inference is disclosed (EI-20981827026547630)', () => {
  it('explains both the explicit requirement and the recoverable measuredAt-only form', () => {
    const subjectVolatile = assertSchemaField('subjectVolatile').description ?? '';
    const measuredAt = assertSchemaField('measuredAt').description ?? '';

    expect(subjectVolatile).toMatch(/measuredAt is required/i);
    expect(subjectVolatile).toMatch(/store infers subjectVolatile:true/i);
    expect(measuredAt).toMatch(/required with subjectVolatile:true/i);
    expect(measuredAt).toMatch(/supplying measuredAt alone is accepted.*store infers subjectVolatile:true/i);
    expect(measuredAt).not.toMatch(/refused by the store otherwise/i);
  });
});
