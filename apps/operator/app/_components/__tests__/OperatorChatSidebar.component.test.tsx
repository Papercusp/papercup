/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OperatorChatSidebar } from '../OperatorChatSidebar';
import { OPERATOR_CHAT_COLLAPSED_WIDTH } from '../operator-chat-layout';

vi.mock('nuqs', async () => {
  const React = await import('react');
  return {
    parseAsBoolean: {
      withDefault(defaultValue: boolean) {
        return { defaultValue };
      },
    },
    parseAsString: {
      withDefault(defaultValue: string) {
        return { defaultValue };
      },
    },
    parseAsStringEnum(_values: string[]) {
      return {
        withDefault(defaultValue: string) {
          return { defaultValue };
        },
      };
    },
    useQueryState(_key: string, parser?: { defaultValue?: boolean | string }) {
      return React.useState(parser?.defaultValue ?? true);
    },
    useQueryStates(spec: Record<string, { defaultValue?: unknown }>) {
      const [state, setState] = React.useState(() =>
        Object.fromEntries(Object.entries(spec).map(([k, p]) => [k, p?.defaultValue])),
      );
      return [state, setState];
    },
  };
});

vi.mock('../OperatorConversationProvider', () => ({
  useOperatorConversation: () => ({
    messages: [],
    busy: false,
    mode: 'active',
    bannerText: null,
    error: null,
    hasMoreEarlier: false,
    loadingEarlier: false,
    conversationId: 'conv-1',
    sendUserMessage: vi.fn(),
    generateIdeas: vi.fn(),
    loadEarlier: vi.fn(),
    answerChoice: vi.fn(),
  }),
}));

vi.mock('../OperatorChat', () => ({
  OperatorChat: () => <div data-testid="operator-chat">Operator chat</div>,
}));

vi.mock('../chat/LocalCardHost', () => ({
  LocalCardHost: () => <div data-testid="local-card-host" />,
}));

vi.mock('@/lib/hotkeys', () => ({
  useShortcutAction: () => undefined,
}));

vi.mock('@/lib/use-workspace-id', () => ({
  useWorkspaceId: () => 'ws-test',
}));

vi.mock('../OperatorLogoMark', () => ({
  OperatorLogoMark: ({ className }: { className?: string }) => <span className={className}>Logo</span>,
}));

vi.mock('../OperatorWordmarkLockup', () => ({
  OperatorWordmarkLockup: ({ className, titleClassName, title }: { className?: string; titleClassName?: string; title?: string }) => (
    <div className={className}>
      <strong className={titleClassName}>{title ?? 'Papercup'}</strong>
    </div>
  ),
}));

vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (key: string) => (key === 'brain' ? 'Mug' : key === 'overwatch' ? 'Kettle' : 'Papercup'),
  useLexiconPackId: () => 'classic',
}));

const voiceModeState = { muted: false };
const setVoiceOutputMutedSpy = vi.fn();
vi.mock('../voice/voice-mode', () => ({
  isVoiceOutputMuted: () => voiceModeState.muted,
  setVoiceOutputMuted: (v: boolean) => setVoiceOutputMutedSpy(v),
}));

vi.mock('../OperatorActiveToggle', () => ({
  OperatorActiveToggle: () => <button type="button">Active</button>,
}));

vi.mock('../voice/VoiceButton', () => ({
  VoiceButton: () => <button type="button">Voice</button>,
}));
const localStorageState = new Map<string, string>();

beforeEach(() => {
  voiceModeState.muted = false;
  setVoiceOutputMutedSpy.mockReset();
  localStorageState.clear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => localStorageState.get(key) ?? null,
      setItem: (key: string, value: string) => {
        localStorageState.set(key, String(value));
      },
      removeItem: (key: string) => {
        localStorageState.delete(key);
      },
      clear: () => {
        localStorageState.clear();
      },
    },
  });
});

afterEach(() => {
  cleanup();
  localStorageState.clear();
  document.body.className = '';
  document.body.style.cssText = '';
  document.documentElement.style.removeProperty('--op-chat-w');
});

describe('body-shift commutation contract with the LeftSidebar rail (WI-4725)', () => {
  // The operator-vite LeftSidebar injects an equal-specificity
  // `body.has-left-sidebar { padding-left: calc(--op-chat-w + --left-sidebar-w) }`.
  // Cascade order between the two <style> tags is NOT a contract, so THIS
  // sidebar's shift rules must compute the identical full sum — an
  // op-chat-only padding here puts the rail on top of the main pane
  // (owner-reported overlap, 2026-07-13).
  it('the injected shift rules compose --left-sidebar-w (and --dev-rail-w on the header width)', async () => {
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    const bodyRule = css.match(/body\.has-op-chat\s*\{[^}]*\}/)?.[0] ?? '';
    expect(bodyRule).toContain('var(--op-chat-w');
    expect(bodyRule).toContain('var(--left-sidebar-w, 0px)');
    const headerRule = css.match(/body\.has-op-chat \.pc-header\s*\{[^}]*\}/)?.[0] ?? '';
    expect(headerRule).toContain('var(--left-sidebar-w, 0px)');
    expect(headerRule).toContain('var(--dev-rail-w, 0px)');
  });

  it('the fixed sidebar sits below the dev env-switcher bar (WI-4729 clipped header orb)', async () => {
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    const sidebarRule = css.match(/\.op-chat-sidebar\s*\{[^}]*\}/)?.[0] ?? '';
    // top: 0 hides the header orb under the fixed EnvSwitcherBar — the rail
    // must use the published bar height, same as .pclsb/.pcdar/.pc-header.
    expect(sidebarRule).toContain('top: var(--pc-env-bar-h, 0px)');
  });

  it('keeps the header on ONE line: name truncates, controls hug the right, the mic never stretches (WI-4738)', async () => {
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    // Structure: the Papercup identity toggle, controls, and collapse toggle
    // are all DIRECT siblings on the single .op-chat-header-main row (no
    // title-row/copy column wrappers left to wrap onto a second line). The
    // wordmark now lives INSIDE the Papercup toggle (WI-4793: it shares the
    // 🫖 button's flat pill chrome).
    const main = document.querySelector('.op-chat-header-main');
    expect(main).toBeTruthy();
    const childClasses = Array.from(main!.children).map((c) => c.className);
    expect(childClasses.some((c) => String(c).includes('op-chat-papercup-toggle'))).toBe(true);
    expect(childClasses.some((c) => String(c).includes('op-chat-controls'))).toBe(true);
    expect(document.querySelector('.op-chat-papercup-toggle .op-chat-wordmark')).toBeTruthy();
    expect(document.querySelector('.op-chat-header-copy')).toBeNull();
    expect(document.querySelector('.op-chat-header-title-row')).toBeNull();
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    // The mic's old flex:1 stretch is the "gigantic mic" the owner flagged —
    // pin the natural-size rule and the right-aligned control cluster.
    const voiceControlRule = css.match(/\.op-chat-controls \.pc-voice-control\s*\{[^}]*\}/)?.[0] ?? '';
    expect(voiceControlRule).toContain('flex: 0 0 auto');
    const controlsRule = css.match(/\.op-chat-controls\s*\{[^}]*\}/)?.[0] ?? '';
    expect(controlsRule).toContain('margin-left: auto');
    const titleRule = css.match(/\.op-chat-header-main \.op-chat-wordmark-title\s*\{[^}]*\}/)?.[0] ?? '';
    expect(titleRule).toContain('text-overflow: ellipsis');
  });

  it('the header is ALWAYS the Papercup identity — no Mug/Kettle mark, even with a docked rail (WI-4778 reverts WI-4739)', async () => {
    // Rail docked (the old WI-4739 trigger) → still Papercup: there is no
    // Mug/Kettle chat to switch to; the 🫖 toggle shows their inputs instead.
    document.body.classList.add('has-left-sidebar');
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    expect(screen.getByText('Papercup')).toBeTruthy();
    expect(screen.queryByText('Mug')).toBeNull();
    expect(document.querySelector('.op-chat-header-mark')).toBeNull();
  });

  it('the ambient Mug/Kettle status strip is GONE — the 🫖 toggle is the one entry (WI-4789)', async () => {
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    // The old strip rendered a "Pot status — …" button under the header; the
    // owner asked for it removed once the toggle moved beside the identity.
    expect(screen.queryByRole('button', { name: /^Pot status/ })).toBeNull();
    expect(document.querySelector('.op-pot-status')).toBeNull();
  });

  it('the 🫖 toggle carries its own "Pot Health" wordmark-style label beside the Papercup identity (WI-4789)', async () => {
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    const toggle = screen.getByRole('button', { name: 'Show pot health' });
    const label = toggle.querySelector('.op-chat-pot-toggle-label');
    expect(label?.textContent).toBe('Pot Health');
    // A DIRECT sibling immediately right of the Papercup identity toggle on the
    // single header row (WI-4793: the two pills are peers, Papercup leads).
    const main = document.querySelector('.op-chat-header-main');
    const kids = Array.from(main!.children).map((c) => String(c.className));
    const papercupIdx = kids.findIndex((c) => c.includes('op-chat-papercup-toggle'));
    const potIdx = kids.findIndex((c) => c.includes('op-chat-pot-toggle'));
    expect(potIdx).toBe(papercupIdx + 1);
  });

  it('the Papercup identity is a FLAT peer toggle sharing the 🫖 pill chrome, lit while chat shows, no raised orb (WI-4793)', async () => {
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    // The Papercup identity is its own button carrying the Papercup wordmark +
    // a flat brand glyph — the peer of the 🫖 "Pot Health" pill.
    const papercup = screen.getByRole('button', { name: 'Papercup chat' });
    expect(papercup.querySelector('.op-chat-wordmark-title')?.textContent).toBe('Papercup');
    expect(papercup.querySelector('.op-chat-papercup-mark')).toBeTruthy();
    // Chat is the default face → the Papercup pill is lit (is-on), the 🫖 isn't.
    expect(papercup.className).toContain('is-on');
    expect(papercup.getAttribute('aria-pressed')).toBe('true');
    const pot = screen.getByRole('button', { name: 'Show pot health' });
    expect(pot.className).not.toContain('is-on');
    // Both pills are driven by ONE shared base rule (not a bespoke raised orb),
    // and the old glowing 38px orb element/rules are gone.
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    expect(css).toContain('.op-chat-header-main .op-chat-papercup-toggle');
    expect(css).not.toContain('.op-chat-header-orb');
    expect(document.querySelector('.op-chat-header-orb')).toBeNull();
  });

  it('the Papercup toggle returns to the chat face from the pot view (WI-4793)', async () => {
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    // Open the pot view via the 🫖 toggle.
    fireEvent.click(screen.getByRole('button', { name: 'Show pot health' }));
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Pot health' })).toBeTruthy();
    });
    // The Papercup pill is now unlit; clicking it brings the chat body back.
    const papercup = screen.getByRole('button', { name: 'Papercup chat' });
    expect(papercup.className).not.toContain('is-on');
    fireEvent.click(papercup);
    await waitFor(() => {
      expect(screen.getByTestId('operator-chat')).toBeTruthy();
    });
    expect(screen.queryByRole('region', { name: 'Pot health' })).toBeNull();
  });

  it('the 🫖 toggle swaps the chat body for the full-height Pot Health view and back (WI-4778)', async () => {
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    // Default: the chat body renders, no pot-health region.
    expect(screen.getByTestId('operator-chat')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Pot health' })).toBeNull();

    const toggle = screen.getByRole('button', { name: 'Show pot health' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);

    // 🫖 on: the pot view REPLACES the chat body (same pane, full height).
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Pot health' })).toBeTruthy();
    });
    expect(screen.queryByTestId('operator-chat')).toBeNull();
    const back = screen.getByRole('button', { name: 'Back to chat' });
    expect(back.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(back);

    await waitFor(() => {
      expect(screen.getByTestId('operator-chat')).toBeTruthy();
    });
    expect(screen.queryByRole('region', { name: 'Pot health' })).toBeNull();
  });

  it('the TTS speak-responses mute lives on the chat bar: hydrates, flips + persists, re-syncs on broadcast (WI-4740)', async () => {
    voiceModeState.muted = false;
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    const tts = await screen.findByRole('button', { name: 'Mute spoken responses' });
    expect(tts.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(tts);
    expect(setVoiceOutputMutedSpy).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: 'Unmute spoken responses' })).toBeTruthy();
    // Cross-tab broadcast re-sync (same event contract the middle bar had).
    fireEvent(window, new CustomEvent('papercusp:voiceOutputMutedChanged', { detail: { muted: false } }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Mute spoken responses' })).toBeTruthy();
    });
  });

  it('the compact-density avatar override keeps the agent mark readable (WI-4731)', async () => {
    // The sidebar's own !important density block WINS over globals.css'
    // .oracle-msg-avatar sizing — a globals-only bump silently does nothing
    // in this pane (live-verified 2026-07-13: computed 20px while globals
    // said 34px). Pin the operative override at the readable size so the
    // two-rule trap can't regress.
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    const avatarRules = css.match(/\.op-chat-sidebar \.oracle-msg-avatar\s*\{[^}]*\}/g) ?? [];
    expect(avatarRules.length).toBeGreaterThan(0);
    const important = avatarRules.find((r) => r.includes('!important')) ?? '';
    expect(important).toContain('width: 30px !important');
    expect(important).toContain('height: 30px !important');
    const iconRule = css.match(/\.op-chat-sidebar \.oracle-msg-icon\s*\{[^}]*\}/)?.[0] ?? '';
    expect(iconRule).toContain('width: 18px !important');
  });
});

describe('OperatorChatSidebar collapse behavior', () => {
  it('collapses to a slim rail and can be expanded again', async () => {
    window.localStorage.setItem(wsLocalKey('papercusp.operatorChat.width'), '420');

    render(<OperatorChatSidebar />);

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--op-chat-w')).toBe('420px');
    });
    expect(document.body.classList.contains('has-op-chat')).toBe(true);
    expect(document.body.classList.contains('op-chat-collapsed')).toBe(false);
    expect(screen.getByRole('button', { name: 'Collapse Papercup chat' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Papercup chat' }));

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--op-chat-w')).toBe(`${OPERATOR_CHAT_COLLAPSED_WIDTH}px`);
    });
    expect(document.body.classList.contains('op-chat-collapsed')).toBe(true);
    expect(screen.getByRole('button', { name: 'Expand Papercup chat' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Papercup chat' }));

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--op-chat-w')).toBe('420px');
    });
    expect(document.body.classList.contains('op-chat-collapsed')).toBe(false);
  });
});
