// @vitest-environment jsdom
/**
 * use-open-hud-conversation.test.tsx (resume-in-gui-button-2026-08-09)
 *
 * The hook is four URL writes, and each one is a separate way for the owner-facing
 * behaviour to be quietly wrong:
 *   - miss `tab=hud` and `hudsession` lands in the URL with nothing mounted to read it
 *     (HudView renders on that tab only), so "Resume in GUI" appears to do nothing;
 *   - miss `agentsRoster=null` and the agents popover stays open ON TOP of the board,
 *     covering the conversation the click just asked for (the WI-35969 overlap);
 *   - carry a stale `hudfocus*` and the popup scrolls to a turn that belongs to a
 *     DIFFERENT agent's transcript.
 * None of those throw, so they are only catchable here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSyncExternalStore } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// A real per-key reactive store — the same idiom AgentsPillSessions.test.tsx uses,
// and necessary for the same reason: this hook touches SEVEN independent nuqs keys
// in one tree, so a stub that ignored `key` would collapse them into each other and
// every assertion below would pass vacuously.
const nuqsStore = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
}));
vi.mock('nuqs', () => ({
  parseAsString: { defaultValue: null },
  parseAsBoolean: { defaultValue: null },
  useQueryState: (key: string, parser?: { defaultValue?: unknown }) => {
    if (!(key in nuqsStore.state)) nuqsStore.state[key] = parser?.defaultValue ?? null;
    const value = useSyncExternalStore(
      (onStoreChange: () => void) => {
        nuqsStore.listeners.add(onStoreChange);
        return () => nuqsStore.listeners.delete(onStoreChange);
      },
      () => nuqsStore.state[key],
    );
    const setValue = (v: unknown) => {
      nuqsStore.state[key] = v;
      for (const listener of nuqsStore.listeners) listener();
      return Promise.resolve(true);
    };
    return [value, setValue];
  },
}));

import { useOpenHudConversation } from './use-open-hud-conversation';

function Harness({ ownerId }: { ownerId: string }) {
  const open = useOpenHudConversation();
  return <button type="button" data-testid="go" onClick={() => open(ownerId)}>go</button>;
}

afterEach(() => {
  for (const key of Object.keys(nuqsStore.state)) delete nuqsStore.state[key];
  nuqsStore.listeners.clear();
  cleanup();
});

describe('useOpenHudConversation', () => {
  it('lands on the HUD tab with that agent’s conversation open, and closes the agents popover', () => {
    nuqsStore.state.tab = 'overview';
    nuqsStore.state.agentsRoster = true;
    render(<Harness ownerId="su-1111-2222" />);
    fireEvent.click(screen.getByTestId('go'));
    // HudView (which mounts SessionChatModal) renders on tab=hud ONLY — without
    // this the hudsession below would sit in the URL doing nothing.
    expect(nuqsStore.state.tab).toBe('hud');
    expect(nuqsStore.state.hudsession).toBe('su-1111-2222');
    // The popover we were launched from renders above the board, so it has to go.
    expect(nuqsStore.state.agentsRoster).toBeNull();
  });

  it('drops a stale transcript anchor so the popup opens at the agent’s own history', () => {
    // A prior HUD search left these pointing INTO A DIFFERENT agent's transcript.
    nuqsStore.state.hudfocus = 'some matched line';
    nuqsStore.state.hudfocusts = '2026-08-01T00:00:00Z';
    nuqsStore.state.hudfocusq = 'needle';
    nuqsStore.state.hudfocussid = 'other-session';
    render(<Harness ownerId="su-3333" />);
    fireEvent.click(screen.getByTestId('go'));
    expect(nuqsStore.state.hudfocus).toBeNull();
    expect(nuqsStore.state.hudfocusts).toBeNull();
    expect(nuqsStore.state.hudfocusq).toBeNull();
    expect(nuqsStore.state.hudfocussid).toBeNull();
    expect(nuqsStore.state.hudsession).toBe('su-3333');
  });

  it('writes nothing for an empty owner id (no destination ⇒ no navigation)', () => {
    nuqsStore.state.tab = 'overview';
    render(<Harness ownerId="" />);
    fireEvent.click(screen.getByTestId('go'));
    // Bailing early matters: switching to an EMPTY hud conversation would look like
    // the button worked and then showed nothing. (`hudsession` reads back as null,
    // not undefined — mounting the hook SEEDS every key it subscribes to, exactly as
    // real nuqs does; the assertion that carries the meaning is that `tab` never
    // moved off 'overview'.)
    expect(nuqsStore.state.tab).toBe('overview');
    expect(nuqsStore.state.hudsession).toBeNull();
  });
});
