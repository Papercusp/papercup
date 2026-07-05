/**
 * OnboardingConsole.test.tsx — the WI-3033 external-console routing predicate.
 *
 * Windows must NOT get the embedded pty pane (portable_pty ConPTY wedges
 * wsl.exe on legacy inbox WSL); everything else must keep it. Pure predicate
 * only — the component's render paths (fetch + raw Tauri invoke) are covered
 * by the live VM verification, and jsdom can't host either side meaningfully.
 */
import { describe, expect, it } from 'vitest';

import { shouldRouteExternalConsole } from './OnboardingConsole';

const WINDOWS_WEBVIEW2_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
const MAC_WKWEBVIEW_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const LINUX_WEBKITGTK_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)';

describe('shouldRouteExternalConsole', () => {
  it('routes external on a Windows Tauri webview', () => {
    expect(shouldRouteExternalConsole(true, WINDOWS_WEBVIEW2_UA)).toBe(true);
  });

  it('keeps the embedded terminal on macOS and Linux Tauri webviews', () => {
    expect(shouldRouteExternalConsole(true, MAC_WKWEBVIEW_UA)).toBe(false);
    expect(shouldRouteExternalConsole(true, LINUX_WEBKITGTK_UA)).toBe(false);
  });

  it('never routes external outside Tauri — a browser cannot invoke the command', () => {
    expect(shouldRouteExternalConsole(false, WINDOWS_WEBVIEW2_UA)).toBe(false);
  });
});
