import { describe, expect, it } from 'vitest';
import type { ProjectedTool } from '@papercusp/tooldef';
import { validateRecipeScriptAgainstCatalog } from './recipe-schema-validation';

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
});
