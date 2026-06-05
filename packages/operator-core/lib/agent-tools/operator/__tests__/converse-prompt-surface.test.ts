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
    expect(tui.userPromptText).toContain('tui:dispatch');
    expect(tui.userPromptText).toContain('open_chat');
    expect(tui.userPromptText).toContain('focus_pane');
    expect(tui.userPromptText).toContain('alice@box'); // the client_id is named
    expect(tui.userPromptText).toContain('Do NOT call'); // no chat:ask_choice here

    // Desktop (default) carries none of the TUI affordance.
    const desktop = await buildOperatorPrompt(
      { messages: [{ role: 'user', content: 'hi' }], trigger: 'user_message' },
      null,
    );
    expect(desktop.userPromptText).not.toContain('terminal workbench');
    expect(desktop.userPromptText).not.toContain('tui:dispatch');
  });

  it('falls back to a discovery hint when a TUI turn carries no client_id', async () => {
    const tui = await buildOperatorPrompt(
      { messages: [{ role: 'user', content: 'hi' }], trigger: 'user_message', surface: 'tui' },
      null,
    );
    expect(tui.userPromptText).toContain('terminal workbench');
    expect(tui.userPromptText).toContain('tui:list_clients');
  });
});
