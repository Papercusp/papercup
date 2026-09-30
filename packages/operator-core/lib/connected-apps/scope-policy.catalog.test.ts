/**
 * external-app-access-to-workspaces-2026-09-29 P-003 — R-6 against the REAL tool catalog.
 *
 * `HARD_DENY_GROUPS` is curated, so it can drift from the catalog: a renamed group would
 * silently stop being denied. This pins every entry to a group that exists, and checks the
 * named dangerous tools really are hard-denied as registered (capabilities and all).
 */
import { describe, expect, it } from 'vitest';
import '../agent-tools/index';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { HARD_DENY_GROUPS, appScopeToolOf, hardDenyReason, toolGroupOf, validateAppKeyScopes } from './scope-policy';
import { projectedToolScopeCatalog } from './store';

/** Groups reserved ahead of their tools (P-005 adds the connected_apps management tools). */
const RESERVED_GROUPS = new Set(['connected_apps']);

const catalog = projectedToolScopeCatalog();
const groups = new Set([...catalog.keys()].map(toolGroupOf));

describe('R-6 — the hard-deny set against the live catalog', () => {
  it('the catalog is loaded (positive control: this test measures something)', () => {
    expect(listAllProjectedTools().length).toBeGreaterThan(200);
    expect(catalog.has('harness:list')).toBe(true);
  });

  it('every curated hard-deny group exists in the catalog (a rename cannot silently re-open it)', () => {
    const missing = Object.keys(HARD_DENY_GROUPS).filter((g) => !groups.has(g) && !RESERVED_GROUPS.has(g));
    expect(missing).toEqual([]);
  });

  it.each([
    'capability:bash',
    'capability:read',
    'capability:edit',
    'code:run',
    'tools:invoke',
    'dev:restart',
    'dev:pg_query',
    'setup:save_key',
    'processes:kill',
    'fleet:launch-on-plan',
  ])('%s is hard-denied as registered', (name) => {
    const tool = catalog.get(name);
    expect(tool, `${name} is registered`).toBeDefined();
    expect(hardDenyReason(tool!)).not.toBeNull();
  });

  it('every tool whose capabilities include capability:* / secrets:* / processes:* is hard-denied', () => {
    const escaped = [...catalog.values()].filter(
      (t) => t.capabilities.some((c) => /^(capability|secrets|processes):/.test(c)) && hardDenyReason(t) === null,
    );
    expect(escaped.map((t) => t.name)).toEqual([]);
  });

  it('an ordinary workspace read (harness:list) is not hard-denied', () => {
    expect(hardDenyReason(catalog.get('harness:list')!)).toBeNull();
  });

  it('issue-time validation refuses a hard-denied tool and accepts an ordinary one against the real catalog', () => {
    expect(validateAppKeyScopes({ tools: ['dev:restart'] }, catalog)).toHaveLength(1);
    expect(validateAppKeyScopes({ tools: ['capability:bash'] }, catalog)).toHaveLength(1);
    expect(validateAppKeyScopes({ tools: ['harness:list'] }, catalog)).toEqual([]);
    expect(validateAppKeyScopes({ tools: ['no-such:tool'] }, catalog)).toHaveLength(1);
  });

  it('appScopeToolOf marks a tool with a harness argument as harness-accepting, and one without as not', () => {
    const props = (t: { inputSchema: Record<string, unknown> }) =>
      (t.inputSchema.properties ?? {}) as Record<string, unknown>;
    const named = listAllProjectedTools().filter((t) => t.expose.mcp?.name);
    const withHarness = named.find((t) => 'harness' in props(t) && t.harness !== 'none');
    const without = named.find(
      (t) => !['harness', 'harnessSlug', 'harness_slug'].some((k) => k in props(t)) && !t.harness,
    );
    expect(withHarness, 'a catalog tool takes a harness argument').toBeDefined();
    expect(without, 'a catalog tool takes no harness argument').toBeDefined();
    expect(appScopeToolOf(withHarness!.expose.mcp!.name, withHarness!).acceptsHarness).toBe(true);
    expect(appScopeToolOf(without!.expose.mcp!.name, without!).acceptsHarness).toBe(false);
  });
});
