import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import './agent-tools/index';
import {
  PRODUCTION_TOOL_REGISTRY_ENTRYPOINT,
  buildBuiltinToolCatalog,
  buildProductionToolSourceFiles,
} from './static-tool-catalog';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function liveMcpNames(): Set<string> {
  return new Set(
    listAllProjectedTools()
      .map((tool) => tool.expose.mcp?.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );
}

describe('static tool catalog production registry parity', () => {
  it('keeps generated scorer contracts identical to the complete production registry', () => {
    const catalog = JSON.parse(readFileSync(resolve(REPO_ROOT, '.papercusp/tool-catalog.json'), 'utf8')) as {
      tools: Array<{ name: string | null; description: string }>;
    };
    const projected = catalog.tools.flatMap(tool => tool.name
      ? [{ name: tool.name, description: tool.description }] : []);
    const live = listAllProjectedTools().flatMap(tool => tool.expose.mcp
      ? [{ name: tool.expose.mcp.name, description: tool.description }] : []);
    const byName = (left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name);
    expect(projected.sort(byName), 'regenerate the catalog when a tool name or description changes')
      .toEqual(live.sort(byName));
  });

  it('matches every projected MCP identity in the production registry exactly', () => {
    const derived = buildBuiltinToolCatalog(REPO_ROOT);
    const live = liveMcpNames();
    const missing = [...live].filter((name) => !derived.has(name)).sort();
    const extra = [...derived].filter((name) => !live.has(name)).sort();

    expect(buildProductionToolSourceFiles(REPO_ROOT)).toContain(
      resolve(REPO_ROOT, PRODUCTION_TOOL_REGISTRY_ENTRYPOINT),
    );
    expect(derived.size, 'graph/AST catalog floor — a collapsed scan must fail loudly').toBeGreaterThan(800);
    expect({ missing, extra }, 'derived catalog must have no missing or invented MCP names').toEqual({
      missing: [],
      extra: [],
    });
    expect(derived.size).toBe(live.size);
  });
});
