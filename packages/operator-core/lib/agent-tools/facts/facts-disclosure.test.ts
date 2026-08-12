/**
 * EI-10952 (facts:assert silently truncated a >500-char body and returned a clean ok:true)
 * and EI-10948 (facts:list returned 50 × 500-char bodies ≈ 56k chars and blew the
 * tool-output budget).
 *
 * Both are the same defect in different clothes: the tool KNEW something the caller needed
 * (your write was lossy / this read is huge) and said nothing.
 */
import { describe, expect, it } from 'vitest';
import assertTool, { truncationField } from './assert';
import factsListTool, {
  projectFact,
  isLiveFact,
  findLiveFactVersion,
  FACTS_LIST_EXCERPT_CHARS,
  FACTS_LIST_DEFAULT_LIMIT,
} from './list';
import { clampFactBody, FACT_BODY_MAX_CHARS, type AgentFact } from '../../agent-facts/store';

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

  it('NEVER excerpts away the staleness flag — it is the reason you are reading the list', () => {
    const stale = {
      sourceItem: 'EI-10539',
      sourceItemState: 'resolved',
      note: 'may be stale',
    };
    const row = projectFact({ ...fact('z'.repeat(500)), sourceStale: stale }, false);
    expect(row.stale).toEqual(stale);
  });

  it('a default-limit page of worst-case facts fits the budget that used to blow up', () => {
    // The live failure: 50 rows × ~1.1k chars = 55,842 chars → hard error, spilled to a file.
    const rows = Array.from({ length: FACTS_LIST_DEFAULT_LIMIT }, () =>
      projectFact(fact('z'.repeat(500)), false),
    );
    const chars = JSON.stringify(rows).length;
    expect(chars).toBeLessThan(12_000);
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
});

describe('facts:assert body schema — declared vs enforced cap must not mislead the caller (EI-18670525043445474)', () => {
  it('front-loads the REAL storage cap (FACT_BODY_MAX_CHARS) in the body description, not just the 4000 transport ceiling', () => {
    const description = assertTool.args.shape.body.description ?? '';
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
    const result = assertTool.args.shape.body.safeParse(over500);
    expect(result.success).toBe(true); // accepted, NOT rejected — clampFactBody truncates it downstream
  });

  it('the schema still REJECTS a body past the 4000 transport ceiling (the genuine hard limit)', () => {
    const wayOver = 'x'.repeat(4001);
    const result = assertTool.args.shape.body.safeParse(wayOver);
    expect(result.success).toBe(false);
  });
});
