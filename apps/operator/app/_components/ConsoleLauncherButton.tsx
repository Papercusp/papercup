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
        console.info('[console-launcher] button clicked', { supported, harnessSlug });
        if (!supported) {
          toast.info('Native terminal only opens from the desktop app.', { duration: 6000 });
          return;
        }
        setBusy(true);
        try {
          await launchNativeConsole({ slug: harnessSlug });
          // Long-toast success in case the terminal opened on another
          // monitor / workspace and the user wonders if it worked.
          toast.success('Terminal launched.', { duration: 4000 });
        } catch (e: any) {
          console.error('[console-launcher] launch failed', e);
          toast.error(`Terminal launch failed: ${e?.message ?? 'unknown error'}`, {
            duration: 10000,
          });
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
  // Rounded rectangle with `>_` inside (terminal) + a small `+` badge
  // on the top-right corner so the affordance reads as "open new
  // console" not just "console". The badge sits on a filled accent
  // disc so it pops against the dark chrome background.
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
      {/* Terminal body */}
      <rect x="1.6" y="3.2" width="14.8" height="11.6" rx="1.8" />
      {/* Prompt chevron */}
      <path d="M4.6 7.2 L7.0 9.0 L4.6 10.8" />
      {/* Cursor underscore */}
      <line x1="8.4" y1="11.6" x2="12.6" y2="11.6" />
      {/* "+" badge on the top-right corner — disc + crossing lines.
          stroke="none" + fill on the disc so it visually layers over
          the terminal outline; the cross uses a contrasting stroke. */}
      <circle cx="14.5" cy="3.5" r="3.1" fill="#0b1019" stroke="currentColor" strokeWidth="1.4" />
      <line x1="14.5" y1="1.9" x2="14.5" y2="5.1" strokeWidth="1.5" />
      <line x1="12.9" y1="3.5" x2="16.1" y2="3.5" strokeWidth="1.5" />
    </svg>
  );
}

function extractHarnessSlug(pathname: string): string | null {
  const m = pathname.match(/^\/harness\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
