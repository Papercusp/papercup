/**
 * Slash-prompt projection parity (slash-exposure-tool-catalog-2026-06-12
 * P-004/P-005): the dynamic `tool:*` prompt catalog mirrors the session's
 * tools/list walk exactly — every visible MCP tool surfaces as a slash
 * prompt unless `expose.slash: false`; role/profile-invisible tools never
 * leak; prompts/get visibility admits exactly what prompts/list listed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  registerProjectedTool,
  listMcpProjections,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
} from '@papercusp/agent-mcp';
import {
  dynamicSlashListings,
  resolveSlashToolForPrompt,
  slashToolVisibleTo,
  renderSlashPromptForTool,
} from '../_mcp-slash-prompts';

afterEach(() => {
  _resetProjectionRegistryForTests();
});

const fn = async () => ({ content: [] });

function makeTool(
  name: string,
  overrides: Partial<ProjectedTool> = {},
): ProjectedTool {
  return {
    pluginName: 'agent-mcp',
    description: `Tool ${name}.`,
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
    capabilities: [`${name.split(':')[0]}:read` as never],
    expose: {
      mcp: { name },
      http: { path: `/api/agent-tools/${name.replaceAll(':', '/')}` },
    },
    fn,
    ...overrides,
  };
}

function registerFixtureCatalog(): void {
  registerProjectedTool(makeTool('demo:list'));
  registerProjectedTool(
    makeTool('ops:restart', {
      agentRoles: ['operator'] as never,
    }),
  );
  registerProjectedTool(
    makeTool('quiet:tool', {
      expose: {
        mcp: { name: 'quiet:tool' },
        http: { path: '/api/agent-tools/quiet/tool' },
        slash: false,
      },
    }),
  );
  registerProjectedTool(
    makeTool('eng:only', {
      profile: 'engineer',
    }),
  );
  registerProjectedTool(
    makeTool('long:name', {
      expose: {
        mcp: { name: 'long:name' },
        http: { path: '/api/agent-tools/long/name' },
        slash: { name: 'shortcut' },
      },
    }),
  );
}

describe('dynamicSlashListings — parity with tools/list (P-004)', () => {
  it('projects every visible tool except expose.slash:false, same walk as tools/list', () => {
    // NB: importing @papercusp/agent-mcp registers real tools as a module
    // side-effect, so the registry is never empty here — assert the parity
    // INVARIANT over whatever is listed instead of an exact global set.
    registerFixtureCatalog();
    const toolListings = listMcpProjections('worker' as never);
    const slashListings = dynamicSlashListings(toolListings);
    const slashNames = new Set(slashListings.map((p) => p.name));

    // Role 'worker' sees the fixtures except ops:restart (operator-only).
    const toolNames = toolListings.map((t) => t.name);
    expect(toolNames).toContain('demo:list');
    expect(toolNames).toContain('quiet:tool');
    expect(toolNames).not.toContain('ops:restart');

    // Parity: every listed tool surfaces exactly one slash prompt, except
    // the slash opt-out; the name override is applied.
    for (const t of toolListings) {
      if (t.name === 'quiet:tool') {
        expect(slashNames.has('tool:quiet:tool')).toBe(false);
        continue;
      }
      const expected = t.name === 'long:name' ? 'tool:shortcut' : `tool:${t.name}`;
      expect(slashNames.has(expected)).toBe(true);
    }
    expect(slashListings.length).toBe(toolListings.length - 1);
  });

  it('never lists a role-invisible tool (the gating leg of parity)', () => {
    registerFixtureCatalog();
    const slashNames = dynamicSlashListings(listMcpProjections('worker' as never)).map(
      (p) => p.name,
    );
    expect(slashNames).not.toContain('tool:ops:restart');

    const operatorNames = dynamicSlashListings(listMcpProjections('operator' as never)).map(
      (p) => p.name,
    );
    expect(operatorNames).toContain('tool:ops:restart');
  });

  it('hides engineer-profile tools from the power profile, mirroring tools/list', () => {
    registerFixtureCatalog();
    const powerListings = listMcpProjections(undefined, 'power');
    const slashNames = dynamicSlashListings(powerListings).map((p) => p.name);
    expect(slashNames).not.toContain('tool:eng:only');
  });

  it('derives prompt arguments from the tool input schema', () => {
    registerFixtureCatalog();
    const listing = dynamicSlashListings(listMcpProjections())
      .find((p) => p.name === 'tool:demo:list')!;
    expect(listing.arguments!.map((a) => a.name)).toEqual(['slug']);
    expect(listing.arguments![0]!.required).toBe(false);
    expect(listing.arguments![0]!.description).toMatch(/required — the agent will ask/);
  });
});

describe('resolveSlashToolForPrompt (P-005)', () => {
  it('resolves the fast path (prompt suffix = MCP name)', () => {
    registerFixtureCatalog();
    expect(resolveSlashToolForPrompt('tool:demo:list')?.expose.mcp?.name).toBe('demo:list');
  });

  it('resolves a slash-name override via the fallback scan', () => {
    registerFixtureCatalog();
    expect(resolveSlashToolForPrompt('tool:shortcut')?.expose.mcp?.name).toBe('long:name');
    // The overridden tool is NOT addressable by its raw MCP name.
    expect(resolveSlashToolForPrompt('tool:long:name')).toBeUndefined();
  });

  it('returns undefined for unknown prompts', () => {
    registerFixtureCatalog();
    expect(resolveSlashToolForPrompt('tool:nope:never')).toBeUndefined();
  });
});

describe('slashToolVisibleTo (P-005 gating parity)', () => {
  it('applies the role allowlist', () => {
    registerFixtureCatalog();
    const ops = resolveSlashToolForPrompt('tool:ops:restart')!;
    expect(slashToolVisibleTo(ops, 'operator' as never)).toBe(true);
    expect(slashToolVisibleTo(ops, 'worker' as never)).toBe(false);
  });

  it('applies the profile gate', () => {
    registerFixtureCatalog();
    const eng = resolveSlashToolForPrompt('tool:eng:only')!;
    expect(slashToolVisibleTo(eng, undefined, 'power')).toBe(false);
    expect(slashToolVisibleTo(eng, undefined, 'engineer')).toBe(true);
  });

  it('denies slash-excluded tools even when resolved directly', () => {
    registerFixtureCatalog();
    // quiet:tool resolves by MCP name but its slash exposure is off.
    const quiet = resolveSlashToolForPrompt('tool:quiet:tool');
    if (quiet) {
      expect(slashToolVisibleTo(quiet)).toBe(false);
    } else {
      expect(quiet).toBeUndefined();
    }
  });
});

describe('renderSlashPromptForTool', () => {
  it('renders the invoke instruction with the advertised schema', () => {
    registerFixtureCatalog();
    const tool = resolveSlashToolForPrompt('tool:demo:list')!;
    const rendered = renderSlashPromptForTool(tool, { slug: 'x' });
    const text = rendered.messages[0]!.content.text;
    expect(text).toContain('`demo:list`');
    expect(text).toContain('- slug: x');
    expect(text).toMatch(/ask the user/);
  });
});
