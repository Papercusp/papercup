import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import captureTool from './capture';
import { coerceCaptureKind } from './capture-coerce';
import { captureImprovement } from '../../harness/improvements/capture-core';
import { resolveAgentIdentity } from '../coordination/identity';

// PG-free unit: capture-core has its own 31-test suite; this pins the tool
// wrapper's two jobs — (1) deriving the `source` label from the caller's
// identity tier, and (2) passing every arg + the resolved identity through to
// the shared core unchanged. (self-learning-central P-001/P-010.)
vi.mock('../../harness/improvements/capture-core');
vi.mock('../coordination/identity');

const mockCapture = vi.mocked(captureImprovement);
const mockIdentity = vi.mocked(resolveAgentIdentity);

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
        rubricRef: 'hive-coordination-health',
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
