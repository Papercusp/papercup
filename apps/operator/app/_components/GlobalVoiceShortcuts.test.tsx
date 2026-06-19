// @vitest-environment jsdom
/**
 * GlobalVoiceShortcuts.test.tsx — render-tier coverage for the Discord-parity
 * voice shortcuts. The component renders nothing; it registers two actions
 * (voice.toggleMute / voice.toggleDeafen) against the shortcut bus, each with
 * the enableOnFormTags opt-in so they fire while typing. We mock useShortcutAction
 * to capture the handlers + opts and mock voice-mode to spy on the bus controls,
 * then invoke each handler and assert the matching toggle fired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const registered: Array<{ id: string; run: (e: KeyboardEvent) => void; opts: unknown }> = [];
vi.mock('../../lib/hotkeys', () => ({
  useShortcutAction: (id: string, run: (e: KeyboardEvent) => void, opts: unknown) => {
    registered.push({ id, run, opts });
  },
}));

const toggleMute = vi.fn();
const toggleDeafen = vi.fn();
vi.mock('./voice/voice-mode', () => ({
  toggleOperatorVoiceMute: () => toggleMute(),
  toggleOperatorVoiceDeafen: () => toggleDeafen(),
}));

import GlobalVoiceShortcuts from './GlobalVoiceShortcuts';

function handlerFor(id: string) {
  return registered.find((r) => r.id === id);
}

beforeEach(() => {
  registered.length = 0;
  toggleMute.mockReset();
  toggleDeafen.mockReset();
});
afterEach(cleanup);

describe('GlobalVoiceShortcuts', () => {
  it('renders nothing', () => {
    const { container } = render(<GlobalVoiceShortcuts />);
    expect(container.firstChild).toBeNull();
  });

  it('registers voice.toggleMute and voice.toggleDeafen', () => {
    render(<GlobalVoiceShortcuts />);
    expect(handlerFor('voice.toggleMute')).toBeTruthy();
    expect(handlerFor('voice.toggleDeafen')).toBeTruthy();
  });

  it('both register with enableOnFormTags so they work while typing', () => {
    render(<GlobalVoiceShortcuts />);
    expect(handlerFor('voice.toggleMute')!.opts).toMatchObject({ enableOnFormTags: ['INPUT', 'TEXTAREA'] });
    expect(handlerFor('voice.toggleDeafen')!.opts).toMatchObject({ enableOnFormTags: ['INPUT', 'TEXTAREA'] });
  });

  it('voice.toggleMute toggles the operator-voice mute', () => {
    render(<GlobalVoiceShortcuts />);
    handlerFor('voice.toggleMute')!.run(new KeyboardEvent('keydown'));
    expect(toggleMute).toHaveBeenCalledTimes(1);
    expect(toggleDeafen).not.toHaveBeenCalled();
  });

  it('voice.toggleDeafen toggles the local deafen', () => {
    render(<GlobalVoiceShortcuts />);
    handlerFor('voice.toggleDeafen')!.run(new KeyboardEvent('keydown'));
    expect(toggleDeafen).toHaveBeenCalledTimes(1);
    expect(toggleMute).not.toHaveBeenCalled();
  });
});
