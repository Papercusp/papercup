/**
 * Shape tests for Phase 1d of the tool-guidance arc.
 *
 * Verifies that guidance authored on the 24 operator-allowed tools
 * actually reaches the assembled system prompt — without burning LLM
 * calls. Full behavioral smokes ("'what's wrong with sheets?' →
 * tool_call escalations_get") require fixture harness setup + budget
 * for a real LLM run; those are deferred to a follow-up Playwright
 * suite once the catalog backfill spans enough roles to make the
 * fixture worth assembling.
 *
 * What this catches:
 *   - guidance silently not registering (e.g. defineTool plumbing bug)
 *   - renderToolsCatalog skipping a real tool name
 *   - byRole override merging swallowing the base field
 *   - empty-state regression (description-only must be backwards-identical)
 *
 * What this does NOT catch:
 *   - whether the model actually picks the right tool given the guidance
 *   - whether the guidance prose is good enough to disambiguate
 *
 * Both of those are LLM-evaluator concerns and belong in a separate
 * Playwright suite once Phase 4-5 lights up enough tools to evaluate.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/* Mock the projection registry with a hand-built fixture matching the
 * shape of Phase 1b's backfilled tools. Avoids importing the full
 * agent-mcp registry into the unit test environment. */
const fixture = [
  {
    expose: { mcp: { name: 'harness:list' } },
    description: 'List harnesses registered in the current workspace.',
    capabilities: ['harness:read'],
    guidance: {
      when: 'User asks "what harnesses do I have?", "show me my projects", or you need a slug to feed into harness:get / harness:status.',
      notWhen: 'For ONE specific harness, use `harness:get`. For a single harness\'s live health (active/done counts), use `harness:status`.',
      chaining: 'Pair with `harness:get` (detail) or `harness:status` (live counts) once you have the slug.',
    },
  },
  {
    expose: { mcp: { name: 'harness:status' } },
    description: 'Get the live status of a harness.',
    capabilities: ['harness:read'],
    guidance: {
      when: 'User asks "what is harness X doing right now?", "is sheets active?", or you need recent-activity counts + phase.',
      notWhen: 'For "what\'s WRONG with X", use `work_items:list` (problems-side view). For static facts about the harness, use `harness:get`.',
    },
  },
  {
    expose: { mcp: { name: 'chat:ask_choice' } },
    description: 'Render a question + clickable button choices.',
    capabilities: ['chat:write'],
    guidance: {
      when: 'You would otherwise end a turn with a yes/no, accept/reject, or pick-one-of question.',
      notWhen: 'For OPEN-ENDED questions ("describe what you want"), keep using plain text.',
    },
  },
  {
    // Unmigrated: no guidance. Backwards-identical = description-only render.
    expose: { mcp: { name: 'plugin:unmigrated' } },
    description: 'A plugin tool that doesn\'t have guidance yet.',
    capabilities: [],
  },
];

vi.mock('@papercusp/agent-mcp', () => ({
  listAllProjectedTools: () => fixture,
}));

beforeEach(() => {
  // Force cache bypass — different tests in the suite need a fresh view.
  process.env.PAPERCUSP_RELOAD_PROMPTS = '1';
});

describe('Phase 1d — backfilled guidance reaches the assembled prompt', () => {
  it('renders the harness:list guidance for an operator-role catalog', async () => {
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const text = renderToolsCatalog('operator', ['harness:list']);
    expect(text).toContain('`harness:list`');
    expect(text).toContain('List harnesses registered');
    expect(text).toContain('When: User asks "what harnesses do I have?"');
    expect(text).toContain('Not when: For ONE specific harness');
    expect(text).toContain('Chaining: Pair with `harness:get`');
  });

  it('disambiguates harness:status from work_items:list via notWhen', async () => {
    // This is the core Phase 1d acceptance: the model must be able to
    // read the catalog and know that "what's wrong" is NOT harness:status.
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const text = renderToolsCatalog('operator', ['harness:status']);
    expect(text).toContain('Not when:');
    expect(text).toContain('work_items:list');
    expect(text).toContain('problems-side');
  });

  it('renders chat:ask_choice guidance (the in-flight tool)', async () => {
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const text = renderToolsCatalog('operator', ['chat:ask_choice']);
    expect(text).toContain('`chat:ask_choice`');
    expect(text).toContain('would otherwise end a turn with a yes/no');
    expect(text).toContain('OPEN-ENDED');
  });

  it('renders unmigrated tools as description-only (no When/Not when/Chaining lines)', async () => {
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const text = renderToolsCatalog('operator', ['plugin:unmigrated']);
    expect(text).toContain('`plugin:unmigrated`');
    expect(text).toContain('A plugin tool that doesn\'t have guidance yet.');
    expect(text).not.toContain('When:');
    expect(text).not.toContain('Not when:');
    expect(text).not.toContain('Chaining:');
  });

  it('mixes migrated + unmigrated tools cleanly in one catalog render', async () => {
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const text = renderToolsCatalog('operator', [
      'harness:list',
      'plugin:unmigrated',
      'chat:ask_choice',
    ]);
    // All three present, sorted alphabetically (chat:, harness:, plugin:).
    const chatPos = text.indexOf('`chat:ask_choice`');
    const harnessPos = text.indexOf('`harness:list`');
    const pluginPos = text.indexOf('`plugin:unmigrated`');
    expect(chatPos).toBeGreaterThan(-1);
    expect(harnessPos).toBeGreaterThan(chatPos);
    expect(pluginPos).toBeGreaterThan(harnessPos);
    // Migrated tools have When; unmigrated does not (single instance check).
    const whenMatches = text.match(/When:/g)?.length ?? 0;
    expect(whenMatches).toBe(2); // harness:list + chat:ask_choice, NOT plugin:unmigrated
  });
});

describe('P-009 (token-usage-reduction) — runtime blocks never disturb the cacheable prefix', () => {
  it('runtime context is purely appended: assembly-with-runtime startsWith assembly-without', async () => {
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const toolNames = ['harness:list', 'chat:ask_choice'];
    const base = assembleRolePrompt({ role: 'operator', toolNames });
    const withRuntime = assembleRolePrompt({
      role: 'operator',
      toolNames,
      runtime: [{ heading: 'Trigger', body: `run-id=abc ts=${Date.now()}` }],
    });
    expect(withRuntime.text.startsWith(base.text)).toBe(true);
    // And the runtime section is the LAST contributor.
    expect(withRuntime.sections[withRuntime.sections.length - 1]?.name).toBe('runtime');
  });

  it('two assemblies with different volatile runtime share a byte-identical prefix (prefix-hash)', async () => {
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const toolNames = ['harness:list', 'harness:status'];
    const a = assembleRolePrompt({
      role: 'operator',
      toolNames,
      runtime: [{ heading: 'Trigger', body: 'run A at 2026-06-10T01:00:00Z' }],
    });
    const b = assembleRolePrompt({
      role: 'operator',
      toolNames,
      runtime: [{ heading: 'Trigger', body: 'run B at 2026-06-10T09:59:59Z — totally different' }],
    });
    const runtimeChars = (p: { text: string; sections: Array<{ name: string; chars: number }> }) =>
      p.sections.find((s) => s.name === 'runtime')?.chars ?? 0;
    // Strip each assembly's own runtime tail; the remainder must be identical bytes.
    const stableA = a.text.slice(0, a.text.length - runtimeChars(a));
    const stableB = b.text.slice(0, b.text.length - runtimeChars(b));
    expect(stableA).toBe(stableB);
  });
});
