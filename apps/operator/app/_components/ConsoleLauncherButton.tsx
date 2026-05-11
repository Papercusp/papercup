'use client';

/**
 * ConsoleLauncherButton — the "+" button in the global chrome that
 * opens an OS-native terminal in the active harness's directory with
 * env + .mcp.json pre-configured for superuser MCP access.
 *
 * The icon shows a terminal/console glyph (rounded rectangle with `>_`),
 * not a literal `+`, per user's review of the v2 plan.
 *
 * Flow: click → POST /api/agent-mcp/console/resolve → Tauri
 * console_launch command → native terminal opens in a new window.
 *
 * Visible only inside the Tauri desktop app. In the browser-served
 * dev mode (no Tauri bridge), the button hides itself rather than
 * showing a button that does nothing.
 */

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';

import { launchNativeConsole, isConsoleLauncherSupported } from '@/lib/native-console';

export function ConsoleLauncherButton() {
  const [busy, setBusy] = useState(false);
  // Tracked but not used as a hide-gate any more — we render the
  // button on every page (browser + Tauri) and explain on click if
  // the user is in the browser-served operator without the desktop
  // bridge. Hiding it conditionally meant the user couldn't see
  // where this affordance was supposed to live.
  const [supported, setSupported] = useState(true);
  const pathname = usePathname();
  const harnessSlug = extractHarnessSlug(pathname ?? '');

  useEffect(() => {
    setSupported(isConsoleLauncherSupported());
  }, []);

  const tooltip = supported
    ? (harnessSlug
        ? `Launch terminal in ${harnessSlug}`
        : 'Launch terminal in workspace root')
    : 'Launch terminal (desktop app only)';

  return (
    <button
      type="button"
      className={`pc-console-btn${busy ? ' is-busy' : ''}${supported ? '' : ' is-unsupported'}`}
      aria-label="Launch terminal"
      title={tooltip}
      disabled={busy}
      onClick={async () => {
        if (!supported) {
          toast.info('The native terminal only opens from the desktop app.');
          return;
        }
        setBusy(true);
        try {
          await launchNativeConsole({ slug: harnessSlug });
        } catch (e: any) {
          toast.error(`Terminal launch failed: ${e?.message ?? 'unknown error'}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ConsoleIcon />
    </button>
  );
}

function ConsoleIcon() {
  // Rounded rectangle with `>_` inside — reads "terminal" at 18px.
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.6" y="3.2" width="14.8" height="11.6" rx="1.8" />
      <path d="M4.6 7.2 L7.0 9.0 L4.6 10.8" />
      <line x1="8.4" y1="11.6" x2="12.6" y2="11.6" />
    </svg>
  );
}

function extractHarnessSlug(pathname: string): string | null {
  const m = pathname.match(/^\/harness\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
