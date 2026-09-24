import { describe, expect, it } from 'vitest';
import type { ProjectedTool } from '@papercusp/tooldef';
import { inspectDurability } from './durability-inspection';

const tool = (name: string, effect: 'read' | 'write', idempotent = false) => ({
  expose: { mcp: { name } }, effect, idempotent,
}) as ProjectedTool;
const bindings = { inputs: { item: 'WI-1' }, secretRefs: {}, resourceRefs: {} };

describe('orchestration durability inspection', () => {
  it('pins source/bindings and derives stable step IDs from registered read and idempotent effects', async () => {
    const input = {
      script: 'await tools.coord.presence({ fleet: "alpha" }); await tools.plans.setStatus({ item: "P-001", status: "done" });',
      bindings,
      calls: [
        { tool: 'coord:presence', args: { fleet: 'alpha' }, dynamicArgs: false },
        { tool: 'plans:set-status', args: { item: 'P-001', status: 'done' }, dynamicArgs: false },
      ],
      tools: [tool('coord:presence', 'read'), tool('plans:set-status', 'write', true)],
      recipeRevision: 'a'.repeat(64),
    };
    const first = await inspectDurability(input);
    const again = await inspectDurability(input);
    expect(first).toEqual(again);
    expect(first).toMatchObject({
      pin: { sourceSha256: expect.any(String), bindingsSha256: expect.any(String), recipeRevision: 'a'.repeat(64) },
      steps: [
        { tool: 'coord:presence', replay: 'read-only', argsStatic: true },
        { tool: 'plans:set-status', replay: 'idempotent', argsStatic: true },
      ],
      replayCandidate: true,
      durableExecutionAvailable: false,
      diagnostics: [],
    });
    expect((await inspectDurability({ ...input, bindings: { ...bindings, inputs: { item: 'WI-2' } } })).pin.bindingsSha256)
      .not.toBe(first.pin.bindingsSha256);
    expect((await inspectDurability({ ...input, script: input.script + ' ' })).pin.sourceSha256)
      .not.toBe(first.pin.sourceSha256);
  });

  it('rejects an external write without a registered idempotent contract even if authored text calls it safe', async () => {
    const inspected = await inspectDurability({
      script: '/* idempotent: true */ await tools.mail.send({ body: "hello" });',
      bindings,
      calls: [{ tool: 'mail:send', args: { body: 'hello' }, dynamicArgs: false }],
      tools: [tool('mail:send', 'write')],
    });
    expect(inspected).toMatchObject({
      replayCandidate: false,
      steps: [{ effect: 'write', replay: 'uncertain', reason: 'write has no registered idempotent contract' }],
      diagnostics: [{ code: 'uncertain-effect' }],
    });
  });

  it('treats dynamic write arguments and nondeterministic control as uncertain without scanning strings', async () => {
    const inspected = await inspectDurability({
      script: 'const note = "Date.now()"; if (Math.random() > 0.5) await tools.plans.setStatus({ item: input });',
      bindings,
      calls: [{ tool: 'plans:set-status', args: { item: null }, dynamicArgs: true }],
      tools: [tool('plans:set-status', 'write', true)],
    });
    expect(inspected.replayCandidate).toBe(false);
    expect(inspected.steps[0]).toMatchObject({ replay: 'uncertain', argsStatic: false });
    expect(inspected.diagnostics.map((d) => d.code)).toEqual([
      'random-control', 'uncheckpointed-control-flow', 'uncertain-effect',
    ]);
    expect(inspected.diagnostics.map((d) => d.code)).not.toContain('wall-clock');
  });
});
