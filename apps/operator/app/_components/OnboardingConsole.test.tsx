/**
 * OnboardingConsole.test.tsx — the WI-3033 external-console routing predicate.
 *
 * Windows must NOT get the embedded pty pane (portable_pty ConPTY wedges
 * wsl.exe on legacy inbox WSL); everything else must keep it. Pure predicate
 * only — the component's render paths (fetch + raw Tauri invoke) are covered
 * by the live VM verification, and jsdom can't host either side meaningfully.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  loadOnboardConcierge,
  markSetupFinished,
  pollGraduationOnce,
  shouldRouteExternalConsole,
} from './OnboardingConsole';

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

  it('routes external on a Linux Tauri webview — the tutorial runs in a native terminal window (owner directive 2026-07-05)', () => {
    expect(shouldRouteExternalConsole(true, LINUX_WEBKITGTK_UA)).toBe(true);
  });

  it('keeps the embedded terminal on a macOS Tauri webview', () => {
    expect(shouldRouteExternalConsole(true, MAC_WKWEBVIEW_UA)).toBe(false);
  });

  it('never routes external outside Tauri — a browser cannot invoke the command', () => {
    expect(shouldRouteExternalConsole(false, WINDOWS_WEBVIEW2_UA)).toBe(false);
  });
});

describe('pollGraduationOnce (WI-3092: external-console auto-nav home)', () => {
  it('returns true once setup-wizard-state reports finished_at', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ finished_at: '2026-07-05T20:00:00.000Z' }), { status: 200 }),
    );
    await expect(pollGraduationOnce(fetchImpl as unknown as typeof fetch)).resolves.toBe(true);
  });

  it('returns false while finished_at is unset (tutorial still in progress)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ step_status: {} }), { status: 200 }));
    await expect(pollGraduationOnce(fetchImpl as unknown as typeof fetch)).resolves.toBe(false);
  });

  it('returns false (retry-next-poll) on a non-ok response instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 }));
    await expect(pollGraduationOnce(fetchImpl as unknown as typeof fetch)).resolves.toBe(false);
  });

  it('returns false (retry-next-poll) on a network error instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(pollGraduationOnce(fetchImpl as unknown as typeof fetch)).resolves.toBe(false);
  });
});

describe('loadOnboardConcierge (WI-2902: retry the concierge fetch past operator boot)', () => {
  const spec = { command: 'bash', args: ['-lc', 'onboard'], cwd: '/home/tester', env: {} };
  const noSleep = async () => {};

  it('returns the spawn spec on the first successful response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ onboardConcierge: spec }), { status: 200 }),
    );
    await expect(
      loadOnboardConcierge(fetchImpl as unknown as typeof fetch, { sleepImpl: noSleep }),
    ).resolves.toEqual(spec);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('RETRIES connection-refused (fast boot races the disk-served SPA past operator startup) then returns the spec — the WI-2902 regression', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n < 3) throw new Error('connect ECONNREFUSED 127.0.0.1'); // operator not listening yet
      return new Response(JSON.stringify({ onboardConcierge: spec }), { status: 200 });
    });
    await expect(
      loadOnboardConcierge(fetchImpl as unknown as typeof fetch, { sleepImpl: noSleep }),
    ).resolves.toEqual(spec);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('treats a successful { onboardConcierge: null } as authoritative — no retry, falls back to the wizard', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ onboardConcierge: null }), { status: 200 }),
    );
    await expect(
      loadOnboardConcierge(fetchImpl as unknown as typeof fetch, { sleepImpl: noSleep }),
    ).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up (null → explicit wizard fallback) once the deadline passes instead of spinning forever', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('endpoint down');
    });
    await expect(
      loadOnboardConcierge(fetchImpl as unknown as typeof fetch, { deadlineMs: 0, sleepImpl: noSleep }),
    ).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops immediately when shouldContinue is false (component unmounted mid-retry)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('endpoint down');
    });
    await expect(
      loadOnboardConcierge(fetchImpl as unknown as typeof fetch, {
        shouldContinue: () => false,
        sleepImpl: noSleep,
      }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
