/**
 * buildOperatorPrompt — per-surface affordance injection (tui-operator-surface
 * D-001/D-003). One role, one persona; only surface-appropriate AFFORDANCES are
 * injected per turn. A 'tui' turn must steer the brain to the pui control surface
 * (tui:dispatch) and away from the absent web UI — while STEERING it TO the card
 * tool (chat_ask_choice now renders as an inline terminal card, Phase 2a); a
 * 'desktop' (default) turn must NOT carry any of that. I/O collaborators are mocked so the
 * test is deterministic and only exercises the prompt assembly (mirrors the
 * sibling converse.test.ts mocking style).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../memory/injection', () => ({
  buildMemoryContextBlock: vi.fn(async () => null),
  lastUserContext: vi.fn(() => ''),
}));
vi.mock('../../../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
}));
vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-test'),
}));
vi.mock('../../../voice-prefs', () => ({
  loadVoicePrefs: vi.fn(async () => null),
}));
// The sentinel-role prompt gathers sentinel context (a bees/fleet_assignment PG
// read). In a unit env that relation doesn't exist, so the real gatherSentinelContext
// catches + console.warns "[sentinel-context] … failed" — which vitest-fail-on-console
// turns into a test failure. This suite tests PERSONA LOADING, not the context block,
// so stub the gathering PG-free (renderSentinelContext → '' ⇒ the section is skipped).
vi.mock('../../../papercup/papercup-context', () => ({
  buildSentinelContextDeps: vi.fn(() => ({})),
  sentinelScopeLabel: vi.fn(() => 'test-hive'),
  gatherSentinelContext: vi.fn(async () => ({})),
  renderSentinelContext: vi.fn(() => ''),
}));

import { buildOperatorPrompt } from '../converse-prompt';

describe('buildOperatorPrompt — per-surface affordances', () => {
  it('injects the pui control affordance + client_id only on surface="tui"', async () => {
    const tui = await buildOperatorPrompt(
      {
        messages: [{ role: 'user', content: 'open the fleet view' }],
        trigger: 'user_message',
        surface: 'tui',
        uiClientId: 'alice@box',
      },
      null,
    );
    expect(tui.userPromptText).toContain('terminal workbench');
    // Underscore form — the persona advertises the name Claude Code presents
    // to the model (it sanitizes the colon out), not the colon registry name
    // (voice-persona P-005).
    expect(tui.userPromptText).toContain('tui_dispatch');
    expect(tui.userPromptText).toContain('open_chat');
    expect(tui.userPromptText).toContain('focus_pane');
    expect(tui.userPromptText).toContain('alice@box'); // the client_id is named
    // Phase 2a: the terminal now renders inline cards, so the surface STEERS the
    // brain TO chat_ask_choice (no longer a prohibition).
    expect(tui.userPromptText).toContain('chat_ask_choice');
    expect(tui.userPromptText).toContain('inline card');

    // Desktop (default) carries none of the TUI affordance.
    const desktop = await buildOperatorPrompt(
      { messages: [{ role: 'user', content: 'hi' }], trigger: 'user_message' },
      null,
    );
    expect(desktop.userPromptText).not.toContain('terminal workbench');
    expect(desktop.userPromptText).not.toContain('tui_dispatch');
  });

  it('carries the tool-calling contract: no ToolSearch + underscore names (P-005/P-009)', async () => {
    const { systemPromptText } = await buildOperatorPrompt(
      { messages: [{ role: 'user', content: 'hi' }], trigger: 'user_message' },
      null,
    );
    // The brain's tools are loaded non-deferred — steer it off ToolSearch and
    // onto the underscore catalog name (the form Claude Code presents).
    expect(systemPromptText).toContain('Calling tools');
    expect(systemPromptText).toContain('ToolSearch');
    expect(systemPromptText).toContain('harness_status');
    expect(systemPromptText).toMatch(/underscores, never colons/i);
  });

  it('falls back to a discovery hint when a TUI turn carries no client_id', async () => {
    const tui = await buildOperatorPrompt(
      { messages: [{ role: 'user', content: 'hi' }], trigger: 'user_message', surface: 'tui' },
      null,
    );
    expect(tui.userPromptText).toContain('terminal workbench');
    expect(tui.userPromptText).toContain('tui_list_clients');
  });
});

describe('buildOperatorPrompt — role re-home seam (Sentinel)', () => {
  it("role:'operator' (default) loads the operator persona — backward-compatible", async () => {
    // No role passed → defaults to 'operator'; the operator persona's signature
    // line is present and the sentinel's is not.
    const { systemPromptText } = await buildOperatorPrompt(
      { messages: [{ role: 'user', content: 'hi' }], trigger: 'user_message' },
      null,
    );
    expect(systemPromptText).toContain('# Operator persona');
    expect(systemPromptText).not.toContain('# Papercup persona');

    // Explicit role:'operator' is identical to the default.
    const explicit = await buildOperatorPrompt(
      { messages: [{ role: 'user', content: 'hi' }], trigger: 'user_message', role: 'operator' },
      null,
    );
    expect(explicit.systemPromptText).toBe(systemPromptText);
  });

  it("role:'papercup' loads the Sentinel persona set (persona + converse + tools.md)", async () => {
    const { systemPromptText } = await buildOperatorPrompt(
      { messages: [{ role: 'user', content: 'hi' }], trigger: 'user_message', role: 'papercup' },
      null,
    );
    // The papercup persona (papercup.persona.md), NOT the operator one.
    expect(systemPromptText).toContain('# Papercup persona');
    expect(systemPromptText).not.toContain('# Operator persona');
    // The papercup converse rules (papercup.converse.md) — the file-and-nudge,
    // never-place charter is the load-bearing difference from the operator.
    expect(systemPromptText).toMatch(/You are the Papercup, not the placer/i);
    // The papercup tools playbook (papercup.tools.md).
    expect(systemPromptText).toContain('# Papercup tool playbook');
  });

  it("role:'papercup' picks the sentinel audience-mode overlay (novice)", async () => {
    const { systemPromptText } = await buildOperatorPrompt(
      {
        messages: [{ role: 'user', content: 'hi' }],
        trigger: 'user_message',
        role: 'papercup',
        audienceMode: 'novice',
      },
      null,
    );
    // The novice overlay leads every persona's mode file; the sentinel novice
    // overlay carries the "suggest and hand off; you don't do the building" line
    // that distinguishes Sentinel from the operator's novice overlay.
    expect(systemPromptText).toContain('# Audience mode: Novice');
    expect(systemPromptText).toMatch(/suggest and hand off/i);
  });
});
