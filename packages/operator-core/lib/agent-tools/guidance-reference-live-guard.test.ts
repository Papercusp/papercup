/**
 * Guard the tool-call links that live tools expose to agents (EI-20201376783862580).
 *
 * The projected catalog is the source of truth: a retired tool must not remain in a
 * live description or guidance field. This deliberately scans only the model-facing
 * description and action guidance, not argument descriptions or `guidance.returns`,
 * whose `key:value` examples are response-shape data rather than tool calls.
 */
import { describe, expect, it } from 'vitest';

import './index';
import { listAllProjectedTools } from '@papercusp/agent-mcp';

type Surface = { path: string; text: string };
type CatalogTool = {
  expose?: { mcp?: { name?: string } };
  description?: unknown;
  guidance?: unknown;
};

const TOOL_TOKEN_RE = /\b([a-z][a-z0-9_-]{1,}:[a-z][a-z0-9_-]{1,})\b/g;

/** Deliberate prose placeholder, not a request to call a real tool. */
const NON_TOOL_REFERENCES = new Set([
  'group:verb',
  'harness:plan_reviews',
  'work-item:done',
  // Event KEY (events:await rendezvous), not a tool call — same precedent as
  // 'work-item:done' above; referenced by fleet/bench.ts's description.
  'work-item:claimable',
  // Credential-ref VALUE (inference-gateway/credential-store.ts), not a tool call;
  // accounts:register's description lists it beside apikey:env:NAME / apikey:file:<path>.
  'apikey:credentials',
]);
/** Common `key:value` data literals that share the tool-token grammar. */
const STRUCTURED_VALUES = new Set(['true', 'false', 'null', 'undefined', 'shared', 'exclusive']);
const STRUCTURED_KEYS = new Set([
  'stageAllWakes',
  'clear',
  'soft',
  'run_in_background',
  'confirm',
  'op',
  'dry_run',
  'wake',
]);

function isStructuredValue(token: string): boolean {
  const colon = token.indexOf(':');
  const key = token.slice(0, colon);
  const value = token.slice(colon + 1);
  return STRUCTURED_KEYS.has(key) || STRUCTURED_VALUES.has(value);
}

function addReference(out: Set<string>, token: string) {
  if (!isStructuredValue(token)) out.add(token);
}

function collectGuidanceStrings(value: unknown, path = 'guidance', seen = new Set<object>()): Surface[] {
  if (typeof value === 'string') return [{ path, text: value }];
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectGuidanceStrings(entry, `${path}.${index}`, seen));
  }
  return Object.entries(value).flatMap(([key, entry]) => collectGuidanceStrings(entry, `${path}.${key}`, seen));
}

function tokenMatches(text: string): Array<{ token: string; offset: number }> {
  return [...text.matchAll(TOOL_TOKEN_RE)].map((match) => ({ token: match[1]!, offset: match.index ?? 0 }));
}

function addCodeSpanMatches(text: string, out: Set<string>) {
  for (const span of text.matchAll(/`([^`]+)`/g)) {
    const value = span[1]!.trim();
    const matches = tokenMatches(value);
    if (matches.length === 1 && matches[0]!.token === value) addReference(out, value);
  }
}

/**
 * Extract only call-like guidance references. In particular, do not treat
 * `active:true`, `mode:shared`, or other structured examples as tool names.
 */
function referencedTools(surface: Surface): Set<string> {
  const refs = new Set<string>();
  const { path, text } = surface;
  if (/\.returns(?:\.|$)/.test(path)) return refs;
  if (path.endsWith('.description')) addCodeSpanMatches(text, refs);

  if (path.endsWith('.seeAlso') || /\.seeAlso\.\d+$/.test(path)) {
    const first = tokenMatches(text)[0];
    if (first && text.slice(0, first.offset).trim() === '') addReference(refs, first.token);
    return refs;
  }

  if (path.endsWith('.chaining')) {
    for (const { token, offset } of tokenMatches(text)) {
      const before = text.slice(0, offset).trimEnd();
      const after = text.slice(offset + token.length);
      if (/(?:^|→|->|;)\s*$/.test(before) || /^\s*\{/.test(after)) addReference(refs, token);
    }
    return refs;
  }

  if (path.endsWith('.when') || path.endsWith('.notWhen')) {
    const action =
      /\b(?:call|use|using|via|route(?:d)?\s+to|pick(?:ing)?)(?:\s+(?:a|an|the))?\s+([a-z][a-z0-9_-]{1,}:[a-z][a-z0-9_-]{1,})\b/gi;
    for (const match of text.matchAll(action)) addReference(refs, match[1]!);
  }
  return refs;
}

export function danglingGuidanceReferences(
  tools: readonly CatalogTool[] = listAllProjectedTools() as readonly CatalogTool[],
) {
  const registered = new Set(
    tools.map((tool) => tool.expose?.mcp?.name).filter((name): name is string => Boolean(name)),
  );
  const dangling: string[] = [];
  for (const tool of tools) {
    const name = tool.expose?.mcp?.name ?? '<unnamed-tool>';
    const surfaces: Surface[] = [];
    if (typeof tool.description === 'string') surfaces.push({ path: `${name}.description`, text: tool.description });
    surfaces.push(...collectGuidanceStrings(tool.guidance));
    for (const surface of surfaces) {
      for (const token of referencedTools(surface)) {
        if (!registered.has(token) && !NON_TOOL_REFERENCES.has(token))
          dangling.push(`${name} ${surface.path}: ${token}`);
      }
    }
  }
  return dangling;
}

describe('live tool guidance references', () => {
  it('scans the registered catalog, not a source-text approximation', () => {
    const tools = listAllProjectedTools();
    expect(tools.length).toBeGreaterThan(100);
    expect(danglingGuidanceReferences(tools as readonly CatalogTool[])).toEqual([]);
  });

  it('keeps the retired per-harness chunk-loop surface out of the projected catalog', () => {
    const tools = listAllProjectedTools() as readonly CatalogTool[];
    const modelFacingCatalog = tools.flatMap((tool) => [
      tool.expose?.mcp?.name ?? '',
      typeof tool.description === 'string' ? tool.description : '',
      ...collectGuidanceStrings(tool.guidance).map(({ text }) => text),
    ]).join('\n');

    expect(modelFacingCatalog).not.toContain('dev:worker_chunk_loop_metrics');
    expect(modelFacingCatalog).not.toMatch(/\bworkerChunkLoop\b/i);
  });

  it('keeps structured values and prose placeholders out of the tool-reference scan', () => {
    const fixture = [
      {
        expose: { mcp: { name: 'live:tool' } },
        description: 'Use `live:tool` with `active:true` and mode:shared; see group:verb for the generic form.',
        guidance: {
          when: 'Use live:tool when needed.',
          chaining: 'live:tool { active:true } → live:tool.',
          returns: 'Response data may contain `active:true`, `ok:false`, or even a tool-shaped `retired:tool` key.',
        },
      },
    ];
    expect(danglingGuidanceReferences(fixture)).toEqual([]);
  });

  it('catches a missing tool in each action-guidance surface', () => {
    const fixture = [
      { expose: { mcp: { name: 'live:tool' } }, description: '`retired:tool`' },
      { expose: { mcp: { name: 'live:tool' } }, guidance: { when: 'Pick a retired:tool tier.' } },
      { expose: { mcp: { name: 'live:tool' } }, guidance: { chaining: 'live:tool → retired:tool fresh.' } },
      { expose: { mcp: { name: 'live:tool' } }, guidance: { seeAlso: ['retired:tool (the old route)'] } },
    ];
    expect(danglingGuidanceReferences(fixture)).toHaveLength(4);
  });
});
