import { describe, expect, it, vi } from 'vitest';
import { runToolOrchestration, type UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ProjectedTool, ToolResult } from '@papercusp/tooldef';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import evaluateTool from '../plans/evaluate-spec-quality';
import emitTool from '../scorecards/emit';
import getTool from '../scorecards/get';
import { validateRecipeScriptAgainstCatalog } from './recipe-schema-validation';
import { deriveRecipeAuthority } from '../../recipe-authority-derive';
import { recipeBindingSchemaV1Schema, capabilityManifestV1Schema } from '../../recipe-contract';
import { ACTIVATION_QUALITY_PUBLICATION_SCRIPT as script, ACTIVATION_QUALITY_BINDINGS,
  ACTIVATION_QUALITY_CAPABILITIES } from './activation-quality-publication';

const json = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
function fixture(qualityOverride?: unknown, emissionOverride?: unknown, readOverride?: unknown) {
  let draft: Record<string, any>;
  const evaluate = vi.fn(async (args: any) => {
    draft = { rubricRef: 'plan-specification-quality', subject: { kind: 'plan', ref: 'spec-set:' + args.slug },
      terminal: true, ratings: { independent: { rating: 'healthy', evidence: 'Exact evidence $ untouched\n' + args.slug } } };
    const result = { ok: true, verdict: 'pass', specSetHash: 'a'.repeat(64), scorecardDraft: draft };
    return json(typeof qualityOverride === 'function' ? qualityOverride(result) : qualityOverride ?? result);
  });
  const emit = vi.fn(async (_args: unknown) => json(emissionOverride ?? { ok: true, issueId: 'EI-card',
    completionReceipt: { status: 'recorded', effectRef: 'EI-card' }, gradingAuditPending: true }));
  const get = vi.fn(async (_args: unknown) => json(readOverride ?? { ok: true, scorecard: { issueId: 'EI-card',
    rubricRef: draft.rubricRef, subject: draft.subject, evidenceFingerprint: 'evidence-a',
    gradingAudit: { state: 'pending' }, gradingAuditCurrentness: { state: 'unknown' } } }));
  const tool = (name: string, effect: 'read' | 'write', fn: ProjectedTool['fn']) => ({
    pluginName: 'activation-publication-fixture', description: name,
    inputSchema: { type: 'object' }, capabilities: [], effect, expose: { mcp: { name } }, fn,
  }) as ProjectedTool;
  const tools = [tool('plans:evaluate-spec-quality', 'read', evaluate), tool('scorecards:emit', 'write', emit),
    tool('scorecards:get', 'read', get)];
  const run = async (plan: string, expectedSpecSetHash?: string) => {
    const result = await runToolOrchestration(script, {
    ctx: { workspaceId: 'publication-fixture', harnessSlug: 'h', role: 'operator',
      log: vi.fn(), progress: vi.fn(), emit: vi.fn() } as unknown as UnifiedToolContext,
    deps: {}, tools, inputs: { harness: 'h', plan, ...(expectedSpecSetHash ? { expectedSpecSetHash } : {}) },
    });
    expect(result.fieldMisses ?? []).toEqual([]);
    return result;
  };
  return { run, evaluate, emit, get, draft: () => draft };
}

describe('existing activation quality publication recipe', () => {
  it('controlled publication trace requires zero model rating rewrites', async () => {
    const baseline = fixture();
    const response = await baseline.evaluate({ slug: 'controlled-plan' });
    const evaluation = JSON.parse(response.content.find(item => item.type === 'text')!.text);
    await baseline.emit({ ...evaluation.scorecardDraft, targetHive: 'h' });
    const current = fixture();
    const result = await current.run('controlled-plan');
    const expected = baseline.emit.mock.calls[0][0];
    expect(current.emit.mock.calls[0][0]).toEqual(expected);
    expect(JSON.stringify((current.emit.mock.calls[0][0] as any).ratings))
      .toBe(JSON.stringify(evaluation.scorecardDraft.ratings));
    expect(current.evaluate).toHaveBeenCalledOnce();
    expect(current.emit).toHaveBeenCalledOnce();
    expect(result.summary).toMatchObject({ status: 'emitted-pending', ready: false });
    console.info('ACTIVATION_CONTROLLED_TRACE ' + JSON.stringify({ journey: 'publication',
      before: { evaluationCalls: baseline.evaluate.mock.calls.length, emitCalls: baseline.emit.mock.calls.length },
      after: { evaluationCalls: current.evaluate.mock.calls.length, emitCalls: current.emit.mock.calls.length,
        modelRatingRewrites: 0, unchangedDraft: JSON.stringify(current.emit.mock.calls[0][0]) === JSON.stringify(expected) } }));
  });

  it('guidance distinguishes emitted pending ready and claims no unmeasured latency', () => {
    const source = readFileSync(new URL('../../../../../apps/operator-docs/src/content/docs/system/plan-inputs.mdx',
      import.meta.url), 'utf8');
    const guidance = source.split('## Complete activation diagnostic and exact publication')[1]?.split('## Supplying values')[0];
    expect(guidance).toBeTruthy();
    expect(guidance).toContain('activationReadiness:true');
    expect(guidance).toContain('dryRun:true');
    expect(guidance).toContain('persist-exact-passing-plan-specification-quality');
    expect(guidance).toContain('scorecardDraft');
    expect(guidance).toContain('Do not rewrite generated');
    expect(guidance).toContain('emitted-pending');
    expect(guidance).toContain('ready:false');
    expect(guidance).toContain('Canonical `plans:start` and execution guards');
    expect(guidance).toContain('independent');
    expect(guidance).not.toMatch(/\b(?:faster|speedup|latency|milliseconds)\b/i);
  });

  it('passes saved-recipe preflight against the real current input and output contracts', async () => {
    const catalog = [evaluateTool, emitTool, getTool].map(tool => ({
      pluginName: 'canonical-contract', description: tool.name,
      inputSchema: z.toJSONSchema(tool.args as z.ZodType),
      outputJsonSchema: z.toJSONSchema(tool.result as z.ZodType),
      capabilities: [], expose: { mcp: { name: tool.name } }, fn: vi.fn(),
    }) as ProjectedTool);
    const result = await validateRecipeScriptAgainstCatalog(script, catalog);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('has a current versioned binding and capability contract', () => {
    expect(recipeBindingSchemaV1Schema.parse(ACTIVATION_QUALITY_BINDINGS)).toEqual(ACTIVATION_QUALITY_BINDINGS);
    expect(capabilityManifestV1Schema.parse(ACTIVATION_QUALITY_CAPABILITIES)).toEqual(ACTIVATION_QUALITY_CAPABILITIES);
  });
  it('derives the actual saved publication target from validated invocation bindings', async () => {
    const descriptor = await deriveRecipeAuthority(script, { harness: 'h', plan: 'explicit-plan' });
    expect(descriptor).toMatchObject({ unresolved: false, bound: true,
      refs: { plans: ['explicit-plan'], harnesses: ['h'] } });
  });
  it.each(['first-plan', 'second-plan'])('transfers %s evaluator draft byte for byte without model rating rewrites', async plan => {
    const f = fixture();
    const result = await f.run(plan);
    expect(result.ok, result.error).toBe(true);
    expect(f.evaluate).toHaveBeenCalledOnce();
    expect(f.emit).toHaveBeenCalledOnce();
    expect(f.emit.mock.calls[0][0]).toEqual({ ...f.draft(), targetHive: 'h' });
    expect(JSON.stringify((f.emit.mock.calls[0][0] as any).ratings)).toBe(JSON.stringify(f.draft().ratings));
    expect(result.summary).toMatchObject({ status: 'emitted-pending', ready: false, auditState: 'pending', issueId: 'EI-card' });
  });
  it.each([{ ok: false, error: 'unavailable' }, { ok: true, verdict: 'unknown' }, { ok: true, verdict: 'fail' },
    { ok: true, verdict: 'pass', _partial: true }, { ok: true, verdict: 'pass' }])('never emits on refused, unknown or incomplete evaluation %j', async quality => {
    const f = fixture(quality);
    expect((await f.run('p')).summary).toMatchObject({ status: 'evaluation-refused', ready: false });
    expect(f.emit).not.toHaveBeenCalled();
  });
  it('preserves a canonical Discovery refusal without reading success-only fields', async () => {
    const refusal = { ok: false, error: 'discovery_not_ready', discovery: { status: 'stale' },
      nextAction: 'Reconcile the changed source finding.', slug: 'p', harnessSlug: 'h' };
    const f = fixture(refusal);
    const result = await f.run('p');
    expect(result.ok, result.error).toBe(true);
    expect(result.summary).toEqual({ status: 'evaluation-refused', ready: false, evaluation: refusal });
    expect(f.evaluate).toHaveBeenCalledOnce();
    expect(f.emit).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
  });
  it('forwards the expected spec identity and refuses drift before emission', async () => {
    const f = fixture();
    expect((await f.run('p', 'b'.repeat(64))).summary).toMatchObject({ status: 'evaluation-refused' });
    expect(f.evaluate.mock.calls[0][0]).toMatchObject({ expectedSpecSetHash: 'b'.repeat(64) });
    expect(f.emit).not.toHaveBeenCalled();
  });
  it.each([{ partial: true }, { _partial: true }, { _projection: { truncated: true } }])(
    'refuses an otherwise passing full draft carrying incompleteness %j', async marker => {
      const f = fixture((quality: object) => ({ ...quality, ...marker }));
      expect((await f.run('p')).summary).toMatchObject({ status: 'evaluation-refused', ready: false });
      expect(f.emit).not.toHaveBeenCalled();
    });
  it('preserves canonical emission refusal and does not replace its ratings or retry', async () => {
    const f = fixture(undefined, { ok: false, error: 'spec_quality_evaluation_changed' });
    expect((await f.run('p')).summary).toMatchObject({ status: 'emit-refused', ready: false,
      receipt: { error: 'spec_quality_evaluation_changed' } });
    expect(f.emit).toHaveBeenCalledOnce();
    expect(f.get).not.toHaveBeenCalled();
  });
  it.each([{ ok: true }, { ok: true, issueId: 'EI-card', completionReceipt: { status: 'recorded', effectRef: 'EI-other' } }])(
    'requires reconciliation for incomplete or inconsistent emission receipts %j', async emission => {
      const f = fixture(undefined, emission);
      expect((await f.run('p')).summary).toMatchObject({ status: 'needs-reconciliation', ready: false });
      expect(f.emit).toHaveBeenCalledOnce();
      expect(f.get).not.toHaveBeenCalled();
    });
  it('requires exact canonical card readback before describing an emission as observed', async () => {
    const f = fixture(undefined, undefined, { ok: false, error: 'unavailable' });
    expect((await f.run('p')).summary).toMatchObject({ status: 'needs-reconciliation', ready: false });
    expect(f.emit).toHaveBeenCalledOnce();
    expect(f.get).toHaveBeenCalledWith({ issueId: 'EI-card' }, expect.anything());
  });
  it('does not adopt an older equivalent card when this emission has no receipt', async () => {
    const f = fixture(undefined, { ok: true }, { ok: true, scorecard: {
      issueId: 'EI-older', rubricRef: 'plan-specification-quality',
      subject: { kind: 'plan', ref: 'spec-set:p' }, gradingAudit: { state: 'passed' },
    } });
    expect((await f.run('p')).summary).toMatchObject({ status: 'needs-reconciliation', ready: false });
    expect(f.emit).toHaveBeenCalledOnce();
    expect(f.get).not.toHaveBeenCalled();
  });
});
