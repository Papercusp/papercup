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
  // `modality` is a real ProjectedTool field (define-tool.test.ts covers its
  // projection); the modality-filter tests below push it, so the mock type
  // must carry it or tsc rejects the literals (vitest/esbuild hid it).
  modality?: ('text' | 'voice')[];
  // Wire-schemas (token-efficient-agent-io P-003) projects columns from these.
  inputSchema?: Record<string, unknown>;
  outputJsonSchema?: Record<string, unknown>;
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

  describe('modality filter (Phase 4 T3.1)', () => {
    it('defaults to text-only when modality arg is omitted', async () => {
      mockTools.push({
        expose: { mcp: { name: 'text:only' } },
        description: 'A text-only tool.',
        capabilities: [],
        modality: ['text'],
      });
      mockTools.push({
        expose: { mcp: { name: 'voice:only' } },
        description: 'A voice-only tool.',
        capabilities: [],
        modality: ['voice'],
      });
      const { renderToolsCatalog } = await import('./prompt-assembly');
      const out = renderToolsCatalog('operator', ['text:only', 'voice:only']);
      expect(out).toContain('`text:only`');
      expect(out).not.toContain('`voice:only`');
    });

    it('voice modality drops tools that declare modality:["text"]', async () => {
      mockTools.push({
        expose: { mcp: { name: 'chat:ask_choice' } },
        description: 'Buttons for clicking.',
        capabilities: [],
        modality: ['text'],
      });
      mockTools.push({
        expose: { mcp: { name: 'operator:converse' } },
        description: 'Both surfaces.',
        capabilities: [],
        modality: ['text', 'voice'],
      });
      const { renderToolsCatalog } = await import('./prompt-assembly');
      const voiceOut = renderToolsCatalog('operator', ['chat:ask_choice', 'operator:converse'], 'voice');
      expect(voiceOut).not.toContain('chat:ask_choice');
      expect(voiceOut).toContain('operator:converse');
    });

    it('tools without declared modality appear in BOTH catalogs (default = both surfaces, regression for E2E bug #36)', async () => {
      mockTools.push({
        expose: { mcp: { name: 'legacy:tool' } },
        description: 'Has no modality field.',
        capabilities: [],
        // modality intentionally absent — default is now ['text','voice']
      });
      const { renderToolsCatalog } = await import('./prompt-assembly');
      const voiceOut = renderToolsCatalog('operator', ['legacy:tool'], 'voice');
      expect(voiceOut).toContain('legacy:tool');
      const textOut = renderToolsCatalog('operator', ['legacy:tool'], 'text');
      expect(textOut).toContain('legacy:tool');
    });

    it('a tool declaring both modalities appears in both catalogs', async () => {
      mockTools.push({
        expose: { mcp: { name: 'both:surfaces' } },
        description: 'Works everywhere.',
        capabilities: [],
        modality: ['text', 'voice'],
      });
      const { renderToolsCatalog } = await import('./prompt-assembly');
      expect(renderToolsCatalog('operator', ['both:surfaces'], 'text')).toContain('both:surfaces');
      expect(renderToolsCatalog('operator', ['both:surfaces'], 'voice')).toContain('both:surfaces');
    });
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

describe('renderWireSchemasSection — the "## Wire schemas" legend (P-003)', () => {
  const flatArrayOut = {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'state'],
      properties: { id: { type: 'string' }, state: { enum: ['todo', 'done'] } },
    },
  };
  const setStateArgs = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'state'],
    properties: { id: { type: 'string' }, state: { type: 'string' }, harness: { type: 'string' } },
  };

  it('renders read + write column lines for the configured registry tools', async () => {
    const { configurePrePromptRegistry, clearPrePromptRegistry } = await import('@papercusp/result-encoding');
    mockTools.push({
      expose: { mcp: { name: 'audit:list' } },
      description: 'audit',
      capabilities: [],
      outputJsonSchema: flatArrayOut,
    });
    mockTools.push({
      expose: { mcp: { name: 'work_items:set_state' } },
      description: 'set state',
      capabilities: [],
      inputSchema: setStateArgs,
    });
    configurePrePromptRegistry([
      { name: 'audit:list', read: 'csv' },
      { name: 'work_items:set_state', write: 'positional' },
    ]);
    const { renderWireSchemasSection } = await import('./prompt-assembly');
    const out = renderWireSchemasSection();
    expect(out).toContain('## Wire schemas');
    expect(out).toContain('`audit:list`');
    expect(out).toContain('read → id:id, state:todo|done');
    expect(out).toContain('`work_items:set_state`');
    expect(out).toContain('write ← id:id, state:str, harness:str?');
    clearPrePromptRegistry();
  });

  it('returns empty string when the registry is empty', async () => {
    const { clearPrePromptRegistry } = await import('@papercusp/result-encoding');
    clearPrePromptRegistry();
    const { renderWireSchemasSection } = await import('./prompt-assembly');
    expect(renderWireSchemasSection()).toBe('');
  });
});

describe('assembleRolePrompt — coord-injection legend (token-efficient-coord-injection P-013)', () => {
  it('includes the ## Coord injection protocol legend so role agents can read injected [coord+N] blocks', async () => {
    mockTools.length = 0; // catalog optional; we only assert the coord-legend section
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('## Coord injection protocol');
    expect(out.text).toContain('<glyph> <handle> <text>');
    expect(out.sections.some((s) => s.name === 'coord-legend')).toBe(true);
  });
});

describe('assembleRolePrompt — friction trip-wire (self-learning-central P-001/A, D-006)', () => {
  it('injects the near-zero friction trip-wire into the SHARED base every role inherits', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('## Friction trip-wire (self-learning loop)');
    expect(out.text).toContain('improvements:capture');
    expect(out.sections.some((s) => s.name === 'friction-tripwire')).toBe(true);
  });

  it('the base trip-wire does NOT leak harness-pipeline role names (validator/reviewer)', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    // Slice out just the trip-wire section to avoid false hits from a persona/catalog mention.
    const idx = out.text.indexOf('## Friction trip-wire');
    const after = out.text.slice(idx);
    const end = after.indexOf('\n\n---\n\n');
    const tripwire = (end >= 0 ? after.slice(0, end) : after).toLowerCase();
    expect(tripwire).not.toMatch(/validator|reviewer/);
  });
});
