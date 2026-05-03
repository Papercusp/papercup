'use client';

import { usePathname } from 'next/navigation';
import { ChatwootWidget } from './ChatwootWidget';
import { OracleDock } from './OracleDock';
import { OperatorButton, OperatorPanel } from './OperatorPanel';
import { OperatorBackgroundScanner } from './OperatorBackgroundScanner';
import { VoiceButton } from './voice/VoiceButton';
import { VoiceAppBridge } from './voice/VoiceAppBridge';
import { AriaLiveRegions } from './voice/AriaLiveRegions';
import { VoiceLeaderBootstrap } from './voice/VoiceLeaderBootstrap';
import { OperatorVoiceAnnouncer } from './voice/OperatorVoiceAnnouncer';
import { HostCheckBanner } from './HostCheckBanner';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import UpdateChip from './UpdateChip';
import TutorialButton from './TutorialButton';

/**
 * Renders the operator's global chrome (header, Oracle dock, hidden
 * Chatwoot SDK bridge, host-check banner) ONLY for routes that aren't
 * designed to be embedded in iframes.
 *
 * Why this exists: operator routes like `/pi` and `/project-docs` are
 * mounted inside iframes by harness plugin tabs (pi-coding, fumadocs).
 * The chrome belongs in the parent harness page, not inside the iframe.
 * Previously the chrome rendered for every route and was hidden via a
 * useEffect-applied body class — that caused a flash of header/dock
 * before the JS ran, and for `/project-docs` the body class was never
 * applied so the chrome leaked permanently.
 *
 * `usePathname()` returns the pathname during SSR for client components,
 * so this skip is server-rendered: the chrome never appears in the HTML
 * for iframe routes, eliminating the flash entirely.
 *
 * Add new iframe-target routes to {@link CHROMELESS_PATH_PREFIXES}.
 */
const CHROMELESS_PATH_PREFIXES: readonly string[] = [
  '/pi',
  '/project-docs',
];

export default function ChromeShell() {
  const pathname = usePathname() ?? '';
  const chromeless = CHROMELESS_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (chromeless) return null;
  return (
    <>
      <header className="pc-header">
        <a href="/" className="brand" aria-label="papercusp" style={{ display: 'flex', alignItems: 'center' }}>
          <img src="/wordmark.svg" alt="papercusp" height={22} style={{ display: 'block' }} />
        </a>
        <span className="pc-header-quote">Nothing is so painful to the human mind as a great and sudden change</span>
        <a href="/harness" className="pc-header-cta pc-header-cta--mission" aria-label="Mission Control">
          <span className="pc-header-cta-orb" aria-hidden="true" />
          <span className="pc-header-cta-label">Mission Control</span>
        </a>
        <OperatorButton />
        <VoiceButton />
        <nav aria-label="Primary navigation">
          <a href="/marketplace/">Marketplace</a>
          <a href="/installed/harnesses">Harnesses</a>
          <a href="/installed/plugins">Plugins</a>
          <a href="/installed/snapshots">Snapshots</a>
          <a href="/support">Support</a>
          <a href="/settings/api-keys">Settings</a>
          <a href="https://github.com/papercupai/papercusp" target="_blank" rel="noopener noreferrer">GitHub</a>
          <TutorialButton />
          <UpdateChip />
          <WorkspaceSwitcher />
        </nav>
      </header>
      <HostCheckBanner />
      <ChatwootWidget />
      <OracleDock />
      <OperatorPanel />
      <OperatorBackgroundScanner />
      <VoiceAppBridge />
      <VoiceLeaderBootstrap />
      <OperatorVoiceAnnouncer />
      <AriaLiveRegions />
    </>
  );
}
