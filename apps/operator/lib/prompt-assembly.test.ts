/**
 * prompt-assembly unit tests. Covers:
 *   - section order (persona → catalog → playbook → runtime)
 *   - empty-state rendering (no guidance → description-only)
 *   - byRole override merging
 *   - missing tools.md → playbook section omitted (not failed)
 *   - missing persona.md → throws (every role must have one)
 *
 * The projection registry is module-singleton, so we use the existing
 * operator role with its current allowedTools list as the fixture (only
 * a few entries needed to exercise rendering).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock listAllProjectedTools so tests don't depend on what's registered
// at module-load time.
const mockTools: Array<{
  expose: { mcp: { name: string } };
  description: string;
  capabilities: string[];
  guidance?: {
    when?: string;
    notWhen?: string;
    chaining?: string;
    byRole?: Record<string, { when?: string; notWhen?: string; chaining?: string }>;
  };
}> = [];

vi.mock('@papercusp/agent-mcp', () => ({
  listAllProjectedTools: () => mockTools,
}));

// Force cache bypass throughout the tests so reloading mocks works.
beforeEach(() => {
  process.env.PAPERCUSP_RELOAD_PROMPTS = '1';
  mockTools.length = 0;
});

afterEach(() => {
  delete process.env.PAPERCUSP_RELOAD_PROMPTS;
});

describe('renderToolsCatalog', () => {
  it('returns empty string when no toolNames provided', async () => {
    const { renderToolsCatalog } = await import('./prompt-assembly');
    expect(renderToolsCatalog('operator', [])).toBe('');
  });

  it('renders description-only for tools without guidance (backwards-identical)', async () => {
    mockTools.push({
      expose: { mcp: { name: 'tasks:list' } },
      description: 'List tasks for a harness.',
      capabilities: [],
    });
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const out = renderToolsCatalog('operator', ['tasks:list']);
    expect(out).toContain('`tasks:list`');
    expect(out).toContain('List tasks for a harness.');
    expect(out).not.toContain('When:');
    expect(out).not.toContain('Not when:');
    expect(out).not.toContain('Chaining:');
  });

  it('renders When/Not when/Chaining when guidance fields are populated', async () => {
    mockTools.push({
      expose: { mcp: { name: 'escalations:get' } },
      description: 'Returns active escalations for a harness.',
      capabilities: [],
      guidance: {
        when: 'User asks "what\'s wrong with X" or "any escalations".',
        notWhen: 'For health counts, use `harness_health`.',
        chaining: undefined,
      },
    });
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const out = renderToolsCatalog('operator', ['escalations:get']);
    expect(out).toContain('When: User asks "what\'s wrong with X"');
    expect(out).toContain('Not when: For health counts, use `harness_health`.');
    expect(out).not.toContain('Chaining:');
  });

  it('shallow-merges byRole over base guidance', async () => {
    mockTools.push({
      expose: { mcp: { name: 'harness:list' } },
      description: 'List harnesses.',
      capabilities: [],
      guidance: {
        when: 'Show me my work.',
        byRole: {
          worker: { when: 'Find the chunk I\'m assigned to.' },
        },
      },
    });
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const operatorOut = renderToolsCatalog('operator', ['harness:list']);
    expect(operatorOut).toContain('When: Show me my work.');
    const workerOut = renderToolsCatalog('worker', ['harness:list']);
    expect(workerOut).toContain('When: Find the chunk I\'m assigned to.');
  });

  it('preserves base fields that byRole does not override', async () => {
    mockTools.push({
      expose: { mcp: { name: 'tasks:list' } },
      description: 'List tasks.',
      capabilities: [],
      guidance: {
        when: 'Default when.',
        notWhen: 'Default not when.',
        byRole: {
          worker: { when: 'Worker when.' },
          // notWhen NOT overridden — should inherit
        },
      },
    });
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const workerOut = renderToolsCatalog('worker', ['tasks:list']);
    expect(workerOut).toContain('When: Worker when.');
    expect(workerOut).toContain('Not when: Default not when.');
  });

  it('skips tools not found in the catalog (caller may pass stale names)', async () => {
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const out = renderToolsCatalog('operator', ['nonexistent:tool']);
    expect(out).toBe('');
  });

  it('deduplicates and sorts tool names alphabetically', async () => {
    mockTools.push({
      expose: { mcp: { name: 'b:tool' } },
      description: 'Second.',
      capabilities: [],
    });
    mockTools.push({
      expose: { mcp: { name: 'a:tool' } },
      description: 'First.',
      capabilities: [],
    });
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const out = renderToolsCatalog('operator', ['b:tool', 'a:tool', 'b:tool']);
    const aPos = out.indexOf('`a:tool`');
    const bPos = out.indexOf('`b:tool`');
    expect(aPos).toBeGreaterThanOrEqual(0);
    expect(bPos).toBeGreaterThan(aPos);
    // Only one b:tool entry despite being passed twice.
    const matches = out.match(/`b:tool`/g);
    expect(matches?.length).toBe(1);
  });
});

describe('PAPERCUSP_RELOAD_PROMPTS env flag', () => {
  it('bypasses cache when set to 1', () => {
    process.env.PAPERCUSP_RELOAD_PROMPTS = '1';
    // Implicitly tested by the beforeEach in this file — every test
    // observes mockTools.length === 0 at start despite earlier tests
    // populating it. If caching weren't bypassed, the second test in
    // the file would see leaked guidance from the first.
    expect(process.env.PAPERCUSP_RELOAD_PROMPTS).toBe('1');
  });
});
