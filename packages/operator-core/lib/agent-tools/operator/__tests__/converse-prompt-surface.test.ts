/**
 * buildOperatorPrompt — per-surface affordance injection (tui-operator-surface
 * D-001/D-003). One role, one persona; only surface-appropriate AFFORDANCES are
 * injected per turn. A 'tui' turn must steer the brain to the pui control surface
 * (tui:dispatch) and away from the absent web UI + the card tool; a 'desktop'
 * (default) turn must NOT carry any of that. I/O collaborators are mocked so the
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
    expect(tui.userPromptText).toContain('Do NOT call'); // no chat_ask_choice here

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

describe('buildOperatorPrompt — role re-home seam (Sentinel-as-Herald)', () => {
  it("role:'operator' (default) loads the operator persona — backward-compatible", async () => {
    // No role passed → defaults to 'operator'; the operator persona's signature
    // line is present and the Herald's is not.
    const { systemPromptText } = await buildOperatorPrompt(
      { messages: [{ role: 'user', content: 'hi' }], trigger: 'user_message' },
      null,
    );
    expect(systemPromptText).toContain('# Operator persona');
    expect(systemPromptText).not.toContain('# Sentinel persona — the Herald');

    // Explicit role:'operator' is identical to the default.
    const explicit = await buildOperatorPrompt(
      { messages: [{ role: 'user', content: 'hi' }], trigger: 'user_message', role: 'operator' },
      null,
    );
    expect(explicit.systemPromptText).toBe(systemPromptText);
  });

  it("role:'sentinel' loads the Herald persona set (persona + converse + tools.md)", async () => {
    const { systemPromptText } = await buildOperatorPrompt(
      { messages: [{ role: 'user', content: 'hi' }], trigger: 'user_message', role: 'sentinel' },
      null,
    );
    // The sentinel persona (sentinel.persona.md), NOT the operator one.
    expect(systemPromptText).toContain('# Sentinel persona — the Herald');
    expect(systemPromptText).not.toContain('# Operator persona');
    // The sentinel converse rules (sentinel.converse.md) — the file-and-nudge,
    // never-place charter is the load-bearing difference from the operator.
    expect(systemPromptText).toContain('You are the Sentinel — the Herald.');
    // The sentinel tools playbook (sentinel.tools.md).
    expect(systemPromptText).toContain('# Sentinel tool playbook');
  });

  it("role:'sentinel' picks the sentinel audience-mode overlay (novice)", async () => {
    const { systemPromptText } = await buildOperatorPrompt(
      {
        messages: [{ role: 'user', content: 'hi' }],
        trigger: 'user_message',
        role: 'sentinel',
        audienceMode: 'novice',
      },
      null,
    );
    // The novice overlay leads every persona's mode file; the sentinel novice
    // overlay carries the "suggest and hand off; you don't do the building" line
    // that distinguishes the Herald from the operator's novice overlay.
    expect(systemPromptText).toContain('# Audience mode: Novice');
    expect(systemPromptText).toMatch(/suggest and hand off/i);
  });
});
