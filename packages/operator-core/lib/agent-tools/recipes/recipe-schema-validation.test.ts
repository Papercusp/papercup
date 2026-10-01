import { describe, expect, it } from 'vitest';
import type { ProjectedTool } from '@papercusp/tooldef';
import { validateRecipeScriptAgainstCatalog } from './recipe-schema-validation';
import '../pre-prompt-registry-config';

const tool = (name: string, inputSchema: Record<string, unknown>): ProjectedTool => ({
  pluginName: 'test',
  description: name,
  inputSchema,
  capabilities: [],
  expose: { mcp: { name } },
  fn: (async () => ({ content: [] })) as never,
});

describe('validateRecipeScriptAgainstCatalog', () => {
  it('rejects a literal enum value removed from the current tool schema', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.release.checkpointRun({ op: "status" });',
      [tool('release:checkpoint-run', {
        type: 'object',
        properties: { force: { type: 'boolean' } },
        additionalProperties: false,
      })],
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain('op');
  });

  it('accepts a literal call whose arguments match the current schema', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.release.deploy({ op: "status" });',
      [tool('release:deploy', {
        type: 'object',
        properties: { op: { type: 'string', enum: ['status', 'trigger'] } },
        required: ['op'],
        additionalProperties: false,
      })],
    );
    expect(result).toEqual({ ok: true, issues: [], staticToolNames: ['release:deploy'] });
  });

  it('normalizes a registered positional write row before checking the target schema', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.workItems.claim({ row: "EI-24779677812251161,,papercusp" });',
      [tool('work_items:claim', {
        type: 'object',
        properties: {
          id: { type: 'string' },
          assignee: { type: 'string' },
          harness: { type: 'string' },
          force: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['id'],
        additionalProperties: false,
      })],
    );

    expect(result).toEqual({ ok: true, issues: [], staticToolNames: ['work_items:claim'] });
  });

  it('accepts framework-reserved payloadTier even though it is absent from the published schema', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.rubrics.get({ rubricRef: "goal-mode-e2e", payloadTier: "full" });',
      [tool('rubrics:get', {
        type: 'object',
        properties: { rubricRef: { type: 'string' } },
        additionalProperties: false,
      })],
    );
    expect(result).toEqual({ ok: true, issues: [], staticToolNames: ['rubrics:get'] });
  });

  it('accepts framework-reserved projection even though it is absent from the published schema', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.work.items({ id: "WI-1", projection: { pick: ["id"] } });',
      [tool('work:items', {
        type: 'object',
        properties: { id: { type: 'string' } },
        additionalProperties: false,
      })],
    );
    expect(result).toEqual({ ok: true, issues: [], staticToolNames: ['work:items'] });
  });

  // EI-19449316000499177: code:run fails closed on `unknown-key` alone, so the CLASSIFICATION is
  // load-bearing, not decoration — a class mislabelled `unknown-key` becomes a false refusal on
  // the fleet's highest-traffic script tool.
  it('classifies an undeclared key as unknown-key (the class code:run refuses on)', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.improvements.capture({ harness: "papercusp", kind: "bug" });',
      [tool('improvements:capture', {
        type: 'object',
        properties: { scope: { type: 'string' }, kind: { type: 'string' } },
        additionalProperties: false,
      })],
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        tool: 'improvements:capture',
        kind: 'unknown-key',
        message: expect.stringContaining('harness'),
      }),
    ]);
  });

  it('classifies a literal/schema type mismatch as `type`, NOT unknown-key — z.coerce may accept it at dispatch', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.plans.revisionDiff({ revisionId: "12" });',
      [tool('plans:revision-diff', {
        type: 'object',
        // The published schema says number; the real tool uses z.coerce so the STRING is accepted
        // at dispatch. Refusing this would be a false positive, which is why code:run does not.
        properties: { revisionId: { type: 'number' } },
        additionalProperties: false,
      })],
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.kind).toBe('type');
    expect(result.issues.some((issue) => issue.kind === 'unknown-key')).toBe(false);
  });

  it('classifies a missing required field as `required`, not unknown-key', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.release.deploy({});',
      [tool('release:deploy', {
        type: 'object',
        properties: { op: { type: 'string' } },
        required: ['op'],
        additionalProperties: false,
      })],
    );
    expect(result.issues[0]?.kind).toBe('required');
  });

  it('a schema WITHOUT additionalProperties:false yields no unknown-key issue (passthrough tools)', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.some.tool({ anythingGoes: 1 });',
      [tool('some:tool', { type: 'object', properties: {} })],
    );
    expect(result.ok).toBe(true);
  });

  it('does not reject dynamic arguments that cannot be proven statically', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'const op = getOp(); return await tools.release.deploy({ op });',
      [tool('release:deploy', {
        type: 'object',
        properties: { op: { type: 'string', enum: ['status'] } },
        required: ['op'],
        additionalProperties: false,
      })],
    );
    expect(result).toEqual({ ok: true, issues: [], staticToolNames: ['release:deploy'] });
  });

  it('skips static argument validation when TypeScript recovered a malformed shell string', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      String.raw`const r = await tools.capability.bash({
        command: "set +e; head -n 12 /tmp/x.log | awk '{print NR ":" substr($0,1,600)}' ; tail -n 18 /tmp/x.log | awk '{print NR ":" substr($0,1,600)}'",
        cwd: "/tmp",
        description: "Sample checkpoint log markers",
        timeout: 15000
      });
      return { output: (r?.output || "").slice(-12000) };`,
      [tool('capability:bash', {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          description: { type: 'string' },
          timeout: { type: 'number' },
        },
        additionalProperties: false,
      })],
    );
    // The malformed script must reach the VM, where it produces compile_error. The validator
    // must not turn TypeScript's recovered pseudo-property into a misleading unknown-key refusal.
    expect(result).toEqual({ ok: true, issues: [], staticToolNames: ['capability:bash'] });
  });
});
