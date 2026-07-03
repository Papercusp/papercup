/**
 * behaviour:run / behaviour:catalog tool tests (desktop-agent-behaviour-suite-2026-07-03 P-014).
 * behaviour:catalog is pure (static check list). behaviour:run score-mode is tested END-TO-END
 * against a REAL temp .jsonl written to disk (exercising the real lib/behaviour-suite scorer +
 * the runner-node file read), so the tool wrapper's wiring — path resolution, the score-mode
 * composition, the scope/model context plumbing, and the arg refinement — is genuinely proven.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/behaviour/run.test.ts
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { behaviourRunTool, behaviourCatalogTool } from './run';

const body = (o: unknown) => JSON.parse((o as { content: { text: string }[] }).content[0]!.text);

let tmpFile: string | undefined;
afterEach(async () => {
  if (tmpFile) await fsp.rm(tmpFile, { force: true });
  tmpFile = undefined;
});

// A clean ornith run (routes local, gates, claims → completes with evidence) and a buggy one
// (direct set_state 'passed' + invented Phase 2) — the same shapes assertions.test proves.
const CLEAN = [
  { type: 'model_change', model: 'ollama-cc/maxwell1500/ornith-35b:IQ3_M' },
  { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'You have been handed this plan to implement. Read it with plans:get then present options.' }] } },
  { type: 'message', message: { role: 'assistant', model: 'maxwell1500/ornith-35b:IQ3_M', content: [{ type: 'toolCall', id: 'a', name: 'mcp__papercusp_su_plans_get', arguments: JSON.stringify({ slug: 'p' }) }] } },
  { type: 'message', message: { role: 'assistant', model: 'maxwell1500/ornith-35b:IQ3_M', content: [{ type: 'text', text: 'Options: (A) do it yourself, (B) hand to the Queen, or (C) launch a fleet. I recommend A. Confirm which route?' }] } },
  { type: 'message', message: { role: 'assistant', model: 'maxwell1500/ornith-35b:IQ3_M', content: [{ type: 'toolCall', id: 'b', name: 'mcp__papercusp_su_work_items_claim', arguments: JSON.stringify({ ids: ['WI-1'] }) }] } },
  { type: 'message', message: { role: 'assistant', model: 'maxwell1500/ornith-35b:IQ3_M', content: [{ type: 'toolCall', id: 'c', name: 'mcp__papercusp_su_work_items_complete', arguments: JSON.stringify({ items: [{ id: 'WI-1', completion: { summary: 'verified in sync, no drift' } }] }) }] } },
];
const BUGGY = [
  { type: 'model_change', model: 'maxwell1500/ornith-35b:IQ3_M' },
  { type: 'message', message: { role: 'assistant', model: 'maxwell1500/ornith-35b:IQ3_M', content: [{ type: 'toolCall', id: 'a', name: 'mcp__papercusp_su_work_items_claim', arguments: JSON.stringify({ i: 'Claim for Phase 2 doc drift', ids: ['WI-999'] }) }] } },
  { type: 'message', message: { role: 'assistant', model: 'maxwell1500/ornith-35b:IQ3_M', content: [{ type: 'toolCall', id: 'b', name: 'mcp__papercusp_su_work_items_set_state', arguments: JSON.stringify({ items: [{ id: 'WI-1', state: 'passed' }] }) }] } },
];

async function writeTranscript(events: unknown[]): Promise<string> {
  const p = join(tmpdir(), `behaviour-run-test-${process.pid}-${events.length}.jsonl`);
  await fsp.writeFile(p, events.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
  tmpFile = p;
  return p;
}

test('behaviour:catalog returns the 8 checks with critical flags', async () => {
  const r = body(await behaviourCatalogTool.handler({} as never, {} as never));
  assert.equal(r.ok, true);
  assert.equal(r.count, 8);
  const ids = r.checks.map((c: { id: string }) => c.id);
  assert.deepEqual(ids, ['model-routing', 'context-fit', 'routing-gate', 'plan-execution', 'scope-adherence', 'lock-discipline', 'fleet-launch', 'completion-evidence']);
  // lock-discipline + completion-evidence are the non-critical (graded) signals
  assert.equal(r.checks.find((c: { id: string }) => c.id === 'lock-discipline').critical, false);
  assert.equal(r.checks.find((c: { id: string }) => c.id === 'model-routing').critical, true);
});

test('behaviour:run score-mode PASSES a clean run via transcriptPath', async () => {
  const path = await writeTranscript(CLEAN);
  const r = body(await behaviourRunTool.handler({ mode: 'score', transcriptPath: path, expectedWorkItemIds: ['WI-1'] } as never, {} as never));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.report.verdict, 'pass', r.report.summary);
  assert.equal(r.report.meta.models[0].includes('ornith'), true);
});

test('behaviour:run score-mode FAILS a buggy run (direct set_state passed + invented Phase 2)', async () => {
  const path = await writeTranscript(BUGGY);
  const r = body(await behaviourRunTool.handler({ mode: 'score', transcriptPath: path, expectedWorkItemIds: ['WI-1'] } as never, {} as never));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.report.verdict, 'fail');
  const byId = Object.fromEntries(r.report.checks.map((c: { id: string; passed: boolean }) => [c.id, c.passed]));
  assert.equal(byId['plan-execution'], false);
  assert.equal(byId['scope-adherence'], false);
});

test('behaviour:run score-mode fails soft when the session has no transcript', async () => {
  const r = body(await behaviourRunTool.handler({ mode: 'score', sessionId: 'definitely-not-a-real-session-zzz' } as never, {} as never));
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes('no transcript'));
});

test('args schema: score needs sessionId/transcriptPath; launch needs planSlug', () => {
  assert.equal(behaviourRunTool.args.safeParse({}).success, false, 'score with neither id nor path');
  assert.equal(behaviourRunTool.args.safeParse({ mode: 'score', sessionId: '9870' }).success, true);
  assert.equal(behaviourRunTool.args.safeParse({ mode: 'score', transcriptPath: '/x.jsonl' }).success, true);
  assert.equal(behaviourRunTool.args.safeParse({ mode: 'launch' }).success, false, 'launch without planSlug');
  assert.equal(behaviourRunTool.args.safeParse({ mode: 'launch', planSlug: 'fixture-p' }).success, true);
});
