import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatIssues } from '@papercusp/tooldef';

import assertTool from './assert';
import { FACT_MAX_SUPERSEDES, FACT_VOLATILE_MAX_TTL_SEC } from '../../agent-facts/store';

const base = {
  scope: 'owner',
  key: 'schema-probe',
  body: 'schema probe',
};

describe('facts:assert settledBy modality contract', () => {
  it('accepts settledBy only on an undecidable fact and requires it there', () => {
    expect(
      assertTool.args.safeParse({
        ...base,
        kind: 'undecidable',
        settledBy: 'a concrete validation probe',
      }).success,
    ).toBe(true);
    expect(assertTool.args.safeParse({ ...base, kind: 'undecidable' }).success).toBe(false);
  });

  it('rejects settledBy on a conclusion, assumption, convention, or undeclared modality', () => {
    for (const kind of ['conclusion', 'assumption', 'convention', undefined]) {
      expect(
        assertTool.args.safeParse({
          ...base,
          ...(kind ? { kind } : {}),
          settledBy: 'a probe that would settle an open question',
        }).success,
        `kind=${kind ?? 'omitted'}`,
      ).toBe(false);
    }
    expect(assertTool.args.safeParse({ ...base }).success).toBe(true);
    expect(assertTool.args.safeParse({ ...base, kind: 'conclusion' }).success).toBe(true);
  });

  it('publishes the conditional relationship as two JSON-schema branches', () => {
    const json = z.toJSONSchema(assertTool.args as never) as {
      anyOf?: Array<{
        required?: string[];
        properties?: Record<string, { const?: unknown; enum?: unknown[]; not?: unknown }>;
        anyOf?: unknown[];
        oneOf?: unknown[];
      }>;
      oneOf?: Array<{
        required?: string[];
        properties?: Record<string, { const?: unknown; enum?: unknown[]; not?: unknown }>;
        anyOf?: unknown[];
        oneOf?: unknown[];
      }>;
    };
    const unionLeaves = (node: {
      anyOf?: Array<unknown>;
      oneOf?: Array<unknown>;
    }): Array<{ required?: string[]; properties?: Record<string, { const?: unknown; enum?: unknown[]; not?: unknown }> }> => {
      const nested = node.anyOf ?? node.oneOf;
      if (!nested) return [node as { required?: string[]; properties?: Record<string, { const?: unknown; enum?: unknown[]; not?: unknown }> }];
      return nested.flatMap((branch) => unionLeaves(branch as { anyOf?: Array<unknown>; oneOf?: Array<unknown> }));
    };
    const branches = unionLeaves(json);

    const undecidable = branches.find((branch) => branch.properties?.kind?.const === 'undecidable');
    const other = branches.find((branch) => branch.properties?.kind?.enum?.includes('conclusion'));
    expect(undecidable?.required).toContain('settledBy');
    expect(other?.required ?? []).not.toContain('settledBy');
    expect(other?.properties?.settledBy).toMatchObject({ not: expect.anything() });
  });
});

describe('facts:assert shareable federation contract', () => {
  it('requires a federation harness, while preserving explicit harness scopeRef', () => {
    expect(assertTool.args.safeParse({ ...base, shareable: true }).success).toBe(false);
    expect(assertTool.args.safeParse({ ...base, shareable: true, harness: 'papercusp' }).success).toBe(true);
    expect(
      assertTool.args.safeParse({
        ...base,
        scope: 'harness',
        scopeRef: 'papercusp',
        shareable: true,
      }).success,
    ).toBe(true);
    expect(assertTool.args.safeParse({ ...base, shareable: false }).success).toBe(true);
  });

  it('publishes the shareable discriminator and harness prerequisite', () => {
    const json = JSON.stringify(z.toJSONSchema(assertTool.args as never));
    expect(json).toContain('shareable');
    expect(json).toContain('Concrete federation harness required');
    expect(json).toContain('const":true');
  });
});

describe('facts:assert measurement input compatibility', () => {
  it('accepts the persisted/read measurement object alongside a conclusion', () => {
    expect(
      assertTool.args.safeParse({
        ...base,
        kind: 'conclusion',
        confidence: 'verified',
        recheck: { probe: 'read the fact', falsifier: 'the fact is no longer true' },
        measurement: {
          subjectVolatile: true,
          measuredAt: '2026-08-30T03:19:00.000Z',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects an incomplete measurement object instead of silently flattening it', () => {
    expect(
      assertTool.args.safeParse({
        ...base,
        kind: 'conclusion',
        measurement: { measuredAt: '2026-08-30T03:19:00.000Z' },
      }).success,
    ).toBe(false);
  });
});

describe('facts:assert supersedes contract', () => {
  it('publishes a bounded sibling-key list on every modality branch', () => {
    expect(
      assertTool.args.safeParse({
        ...base,
        supersedes: Array.from({ length: FACT_MAX_SUPERSEDES }, (_, i) => `old-${i}`),
      }).success,
    ).toBe(true);
    expect(
      assertTool.args.safeParse({
        ...base,
        supersedes: Array.from({ length: FACT_MAX_SUPERSEDES + 1 }, (_, i) => `old-${i}`),
      }).success,
    ).toBe(false);
    expect(assertTool.args.safeParse({ ...base, supersedes: [''] }).success).toBe(false);
  });

  it('documents same-scope atomic retirement and the actual-change receipt', () => {
    const json = JSON.stringify(z.toJSONSchema(assertTool.args as never));
    expect(json).toContain('supersedes');
    expect(json).toContain('SAME workspace/scope/ref');
    expect(json).toContain('receipt reports the keys actually retired');
  });
});

describe('facts:assert cap-admission contract', () => {
  it('documents refusal of destructive cross-author verified eviction and exempt slots', () => {
    const options = (assertTool.args as unknown as { options: Array<{ shape: Record<string, unknown> }> }).options;
    const dryRun = options
      .map((option) => option.shape.dryRun as { description?: string } | undefined)
      .find(Boolean)?.description;

    expect(dryRun).toMatch(/refused before write/i);
    expect(dryRun).toMatch(/another author.*verified fact/i);
    expect(dryRun).toMatch(/conventions and typed safety slots take no cap seat/i);
  });
});

/**
 * EI-21949855462339968 — the volatile-measurement contract must live in the SCHEMA,
 * and the schema's prose must state the verdict the validator actually applies.
 *
 * D-011 turned two of the three volatile rules into repairs (measuredAt alone INFERS
 * subjectVolatile; an over-cap ttlSec is CLAMPED and disclosed) and left exactly one
 * refusal. The published `ttlSec` text was never updated with it, so the schema told
 * callers an over-cap volatile TTL "must be ≤900 seconds" while the store quietly
 * clamped and accepted it — a described refusal the validator does not perform, which
 * is how a legal call looks illegal. Meanwhile the one REAL refusal lived only in the
 * store, so `args.safeParse` accepted input the write rejected and `dryRun:true`
 * forecast `ok:true` for a write that cannot succeed.
 *
 * These pins hold both directions: what is REFUSED must parse as refused, and what is
 * REPAIRED must parse as accepted.
 */
describe('facts:assert volatile-measurement contract', () => {
  const volatileBase = { ...base, key: 'volatile-probe' };

  it('REFUSES subjectVolatile:true without measuredAt at the schema, not only at the write', () => {
    const parsed = assertTool.args.safeParse({ ...volatileBase, subjectVolatile: true });
    expect(parsed.success).toBe(false);
    // Attributed to the missing field, and teaching what the store teaches, so
    // whichever layer refuses reads identically to the caller.
    const issue = parsed.success ? undefined : parsed.error.issues[0];
    expect(issue?.path).toEqual(['measuredAt']);
    expect(issue?.message).toMatch(/subjectVolatile:true requires measuredAt/);
    expect(issue?.message).toMatch(/NOT defaulted to now\(\)/);
  });

  it('accepts the timestamp through either the flat field or the measurement alias', () => {
    const measuredAt = '2026-08-31T11:00:00Z';
    expect(assertTool.args.safeParse({ ...volatileBase, subjectVolatile: true, measuredAt }).success).toBe(true);
    expect(
      assertTool.args.safeParse({
        ...volatileBase,
        subjectVolatile: true,
        measurement: { subjectVolatile: true, measuredAt },
      }).success,
    ).toBe(true);
  });

  it('leaves every D-011 REPAIRED combination accepted — a repair is not a refusal', () => {
    const measuredAt = '2026-08-31T11:00:00Z';
    // Over-cap TTL on a volatile fact is CLAMPED by the store, so the schema must not
    // refuse it. This is the pin that catches the drifted `ttlSec` prose.
    expect(
      assertTool.args.safeParse({
        ...volatileBase,
        subjectVolatile: true,
        measuredAt,
        ttlSec: FACT_VOLATILE_MAX_TTL_SEC * 4,
      }).success,
    ).toBe(true);
    // measuredAt alone INFERS subjectVolatile — accepted, never refused.
    expect(assertTool.args.safeParse({ ...volatileBase, measuredAt }).success).toBe(true);
    // subjectVolatile:false is an ordinary fact and needs no timestamp.
    expect(assertTool.args.safeParse({ ...volatileBase, subjectVolatile: false }).success).toBe(true);
    expect(assertTool.args.safeParse({ ...volatileBase }).success).toBe(true);
  });

  it('publishes the clamp verdict on ttlSec instead of a refusal it does not perform', () => {
    const options = (assertTool.args as unknown as { options: Array<{ shape: Record<string, unknown> }> }).options;
    const describedOn = (field: string) =>
      options.map((option) => option.shape[field] as { description?: string } | undefined).find(Boolean)?.description ?? '';

    const ttlSec = describedOn('ttlSec');
    expect(ttlSec).toMatch(/clamped/i);
    expect(ttlSec).toContain(String(FACT_VOLATILE_MAX_TTL_SEC));
    // The drifted claim: an over-cap volatile TTL described as forbidden while the
    // store accepted it. Nothing here may assert that refusal again.
    expect(ttlSec).not.toMatch(/must be\s*(≤|<=)/i);

    // The one real refusal stays stated AS the only one, on the field that carries
    // it — and beside it, the clamp, so the two verdicts are never conflated again.
    // (facts-disclosure.test.ts separately pins the requirement + inference wording.)
    const subjectVolatile = describedOn('subjectVolatile');
    expect(subjectVolatile).toMatch(/hard refusal/i);
    expect(subjectVolatile).toMatch(/clamped/i);
  });
});

/**
 * EI-22057520151022793 — a private, undecidable work_item fact missing `settledBy`
 * was reported as "shareable: Invalid input: expected true; settledBy: Invalid
 * input: expected string, received undefined". Both clauses come from the
 * FIRST-listed union branch (shareableUndecidable), which the caller never meant:
 * they sent `shareable:false`, which is only legal on the private branches. Every
 * branch of this 6-way union fails at the SAME shallow path-depth for this input,
 * so the old "deepest branch, ties keep the first" rule fell through to raw
 * declaration order and surfaced the WRONG branch's issues — a caller asking for a
 * private fact was told to make it shareable, which has nothing to do with their
 * one real mistake (the missing settledBy). See @papercusp/tooldef's
 * `bestUnionBranch` (standard-schema.ts) for the general fix: on a depth tie,
 * prefer the branch with fewer issues (a closer match) before falling back to
 * declaration order.
 */
describe('facts:assert union branch selection on a private undecidable fact (EI-22057520151022793)', () => {
  it('reports ONLY the missing settledBy for a private (shareable:false) undecidable fact, never the unrelated shareable mismatch', () => {
    const parsed = assertTool.args.safeParse({
      scope: 'work_item',
      scopeRef: 'EI-22057520151022793',
      harness: 'papercusp',
      key: 'schema-probe-private-undecidable',
      body: 'schema probe',
      kind: 'undecidable',
      shareable: false,
      // settledBy deliberately omitted — the caller's one real mistake.
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msg = formatIssues(parsed.error.issues);
      expect(msg).toContain('settledBy');
      // The regression: the shareable-federation branch's irrelevant complaint
      // must never surface for a caller who explicitly asked for shareable:false.
      expect(msg).not.toContain('shareable');
    }
  });

  it('still requires shareable:true (and a federation harness) when the caller actually wants federation', () => {
    // Sanity check in the other direction: this fix must not make the
    // shareable-federation branch unreachable for callers who DO want it.
    expect(
      assertTool.args.safeParse({
        scope: 'work_item',
        scopeRef: 'EI-22057520151022793',
        key: 'schema-probe-shareable-undecidable',
        body: 'schema probe',
        kind: 'undecidable',
        shareable: true,
        settledBy: 'a concrete validation probe',
        harness: 'papercusp',
      }).success,
    ).toBe(true);
  });
});

/**
 * EI-22050255299103531 (legacy `ttlDays` on an owner-fact correction) and
 * EI-22063684320590166 (documented `source_ref` on a workspace fact) are the SAME
 * defect reported twice: a caller sends an otherwise-valid private fact carrying one
 * key this schema does not have, and every branch of the 6-way union fails. The
 * branch that matched everything except that key complains about exactly one thing —
 * the key — but Zod records an `unrecognized_keys` name in `keys` and leaves `path`
 * empty, so it scored path-depth 0 and the "deepest branch wins" rule discarded it in
 * favour of the federation branch's own unmet requirements. Both reporters saw
 * "harness: expected string; shareable: expected true; Unrecognized key: <theirs>" —
 * which reads as an instruction to add federation fields they never wanted, with the
 * one actionable word buried last. EI-22063684320590166 asked for precisely the
 * outcome asserted here: "report only the unknown field". Fixed generally in
 * @papercusp/tooldef's `bestUnionBranch` (standard-schema.ts) by scoring an
 * unrecognized key at the depth of the key it names.
 *
 * NOTE the umbrella these were filed under (EI-22072457901556194) frames them as
 * documented ALIASES that validators fail to implement. They are not: `source_ref`
 * and `ttlDays` are genuinely not part of this schema, and the canonical `sourceRef`
 * and `ttlSec` work. The defect was never the rejection — it was that the rejection
 * pointed at the wrong branch. Adding the aliases would have been the wrong fix.
 */
describe('facts:assert reports a stray key instead of another branch (EI-22050255299103531, EI-22063684320590166)', () => {
  it('names only the unrecognized source_ref on an otherwise valid workspace fact', () => {
    const parsed = assertTool.args.safeParse({
      scope: 'workspace',
      key: 'p018-freeze',
      body: 'the P-018 freeze conclusion',
      source_ref: 'wi:EI-22063684320590166',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msg = formatIssues(parsed.error.issues);
      expect(msg).toContain('source_ref');
      // The regression both reports named: unrelated required fields from a
      // federation branch the caller never asked for.
      expect(msg).not.toContain('harness');
      expect(msg).not.toContain('shareable');
      expect(msg).not.toContain('settledBy');
    }
  });

  it('names only the unrecognized legacy ttlDays on an owner-fact correction', () => {
    const parsed = assertTool.args.safeParse({
      scope: 'owner',
      key: 'launch-provenance',
      body: 'a settled conclusion',
      ttlDays: 7,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msg = formatIssues(parsed.error.issues);
      expect(msg).toContain('ttlDays');
      expect(msg).not.toContain('shareable');
      expect(msg).not.toContain('kind');
    }
  });

  it('accepts the canonical spellings the reports were reaching for', () => {
    // Calibration: proves each rejection above is about the KEY NAME and not
    // about some other defect in the surrounding fact.
    expect(
      assertTool.args.safeParse({
        scope: 'workspace',
        key: 'p018-freeze',
        body: 'the P-018 freeze conclusion',
        sourceRef: 'wi:EI-22063684320590166',
      }).success,
    ).toBe(true);
    expect(
      assertTool.args.safeParse({
        scope: 'owner',
        key: 'launch-provenance',
        body: 'a settled conclusion',
        ttlSec: 604800,
      }).success,
    ).toBe(true);
  });
});
