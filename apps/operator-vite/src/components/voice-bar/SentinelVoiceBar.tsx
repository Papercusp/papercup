'use client';

/**
 * SentinelVoiceBar — the always-visible top voice bar (owner request 2026-06-22).
 *
 * Restores the voice settings + activity strip that used to live in the
 * `op-chat-controls` row atop the (now-retired) Papercup chat sidebar
 * (apps/operator/app/_components/OperatorChatSidebar.tsx → `op-chat-controls`).
 * The chat itself stays gone — the zellij dock replaces it — but the bar is back
 * because it is the ONLY surface that mounts the operator-voice control:
 *
 *   - AudienceModeSelector   — engineer ⇄ novice (a "voice setting")
 *   - OperatorActiveToggle   — active / passive / sleeping / quiet
 *   - VoiceButton            — push-to-talk + live mic / voice ACTIVITY indicator
 *
 * WHY THIS EXISTS: when the chat sidebar was retired, the Vite SPA shell kept the
 * background voice plumbing (VoiceLeaderBootstrap / VoiceAppBridge /
 * OperatorVoiceAnnouncer in ChromeShell + OperatorConversationProvider) but
 * NEVER re-mounted <VoiceButton/>. With no VoiceButton, the operator-voice
 * session could never be started and push-to-talk was dead — so the voice
 * round-trip silently did nothing. Re-mounting the bar revives both.
 *
 * Placement: routes/__root.tsx, directly under <ChromeShell/> and inside
 * <OperatorConversationProvider/> (the controls read its state). Hidden on
 * chromeless iframe routes (mirrors ChromeShell + LeftSidebar).
 *
 * Branding: the persona label comes from the lexicon — "Sentinel" in the-hive
 * pack (t('operator')), "Operator" in classic — never a hardcoded "Papercup".
 */
import { Radio } from 'lucide-react';
import { usePathname } from '@/lib/router-compat/navigation';
import { useLexicon } from '@/lib/useLexicon';
import { AudienceModeSelector } from '@/app/_components/AudienceModeSelector';
import { OperatorActiveToggle } from '@/app/_components/OperatorActiveToggle';
import { VoiceButton } from '@/app/_components/voice/VoiceButton';

// Iframe-target routes render no global chrome (mirror LeftSidebar's list).
const CHROMELESS_PREFIXES = ['/pi', '/project-docs', '/el-min'];

export default function SentinelVoiceBar() {
  const t = useLexicon();
  const persona = t('operator'); // "Sentinel" (the-hive) | "Operator" (classic)
  const pathname = usePathname() ?? '';
  const chromeless = CHROMELESS_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (chromeless) return null;

  return (
    <div className="pc-voice-bar" role="region" aria-label={`${persona} voice controls`}>
      <style>{VOICE_BAR_CSS}</style>
      <span className="pc-voice-bar__brand">
        <Radio size={14} aria-hidden="true" />
        <span className="pc-voice-bar__title">{persona}</span>
        <span className="pc-voice-bar__subtitle">voice &amp; activity</span>
      </span>
      <span className="pc-voice-bar__spacer" />
      <div className="pc-voice-bar__controls">
        <AudienceModeSelector />
        <OperatorActiveToggle />
        <VoiceButton />
      </div>
    </div>
  );
}

// Slim horizontal strip that STICKS just under the sticky header (top: 58px =
// the header's height; no header-height CSS var exists, and a few px of drift
// only shifts the stick point slightly) so it stays visible while scrolling
// rather than sliding behind the header. It is given a clear ACCENT treatment —
// a left accent stripe + accent-tinted gradient + accent top border + shadow —
// because the header and a plain dark bar share the SAME base color and were
// visually indistinguishable: the bar read as a seamless extension of the nav,
// so it couldn't be found (owner: "I'm on staging but don't see the voice bar").
// Offsets (left sidebar) are inherited from the body's `has-left-sidebar` padding.
const VOICE_BAR_CSS = `
.pc-voice-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 7px 18px;
  min-height: 44px;
  position: sticky;
  top: 58px;
  z-index: 1200;
  border-top: 1px solid color-mix(in srgb, var(--accent, #8b5cf6) 55%, transparent);
  border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.18));
  border-left: 3px solid var(--accent, #8b5cf6);
  background:
    linear-gradient(color-mix(in srgb, var(--accent, #8b5cf6) 13%, transparent), transparent),
    color-mix(in srgb, var(--bg-deep, #0b1220), transparent 6%);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.30);
  backdrop-filter: blur(12px) saturate(150%);
  -webkit-backdrop-filter: blur(12px) saturate(150%);
}
.pc-voice-bar__brand { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
.pc-voice-bar__brand svg { color: var(--accent, #8b5cf6); flex-shrink: 0; }
.pc-voice-bar__title { font-size: 12.5px; font-weight: 800; color: var(--fg, #e7f7ff); white-space: nowrap; }
.pc-voice-bar__subtitle { font-size: 10.5px; font-weight: 600; color: var(--fg-mute, #7f9bb4); white-space: nowrap; }
.pc-voice-bar__spacer { flex: 1 1 auto; }
.pc-voice-bar__controls { display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
`;
