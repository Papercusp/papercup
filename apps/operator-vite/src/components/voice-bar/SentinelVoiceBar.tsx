'use client';

/**
 * SentinelVoiceBar — the always-on operator-voice controls, pinned to the TOP of
 * the left Colony sidebar (owner request 2026-06-22: "on top of the left side
 * bar, always — not just when the Sentinel tab is selected"). Rendered by
 * LeftSidebar ABOVE the tab nav, so it shows on EVERY tab (Accounts / Queen /
 * Overwatch / …), not only the Sentinel tab, and is not a separate content-area
 * strip anymore.
 *
 * It is the only surface that mounts <VoiceButton/> (push-to-talk + live mic /
 * voice activity), so it's also what makes the operator-voice round-trip work at
 * all — without it the session never starts and PTT is dead. Bundles the same
 * controls the retired Papercup chat's `op-chat-controls` row had:
 * AudienceModeSelector (engineer ⇄ novice) + OperatorActiveToggle + VoiceButton.
 *
 * Layout: a compact vertical block sized for the ~300px rail (a brand line, the
 * audience segmented toggle, then the active toggle + voice button), with an
 * accent left stripe + bottom divider so it reads as its own region above the
 * tabs. It does NOT position itself — LeftSidebar places it (and already handles
 * collapse + chromeless routes). Persona label comes from the lexicon —
 * "Sentinel" in the-hive pack, "Operator" in classic — never a hardcoded
 * "Papercup".
 */
import { PanelLeftClose, Radio } from 'lucide-react';
import { useLexicon } from '@/lib/useLexicon';
import { AudienceModeSelector } from '@/app/_components/AudienceModeSelector';
import { OperatorActiveToggle } from '@/app/_components/OperatorActiveToggle';
import { VoiceButton } from '@/app/_components/voice/VoiceButton';

export default function SentinelVoiceBar({ onCollapse }: { onCollapse?: () => void }) {
  const t = useLexicon();
  const persona = t('operator'); // "Sentinel" (the-hive) | "Operator" (classic)
  return (
    <div className="pc-voice-bar" role="region" aria-label={`${persona} voice controls`}>
      <style>{VOICE_BAR_CSS}</style>
      <div className="pc-voice-bar__brand">
        <Radio size={13} aria-hidden="true" />
        <span className="pc-voice-bar__title">{persona}</span>
        <span className="pc-voice-bar__subtitle">voice &amp; activity</span>
        {/* Collapse the whole left rail. Sits at the top-right of the rail header
            (replaces the removed empty header row, owner 2026-06-22). PanelLeftClose
            reads unmistakably as a sidebar-collapse control; the collapsed rail
            shows the matching PanelLeftOpen to expand. */}
        {onCollapse && (
          <button
            type="button"
            className="pc-voice-bar__collapse"
            onClick={onCollapse}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <PanelLeftClose size={15} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="pc-voice-bar__controls">
        <AudienceModeSelector />
        <OperatorActiveToggle />
        <VoiceButton />
      </div>
    </div>
  );
}

// Compact vertical block for the left rail (~300px). Accent left stripe + bottom
// divider mark it as its own region above the tab nav. No positioning here — the
// sidebar owns placement and collapse.
const VOICE_BAR_CSS = `
.pc-voice-bar {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 10px 10px;
  border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.18));
  border-left: 3px solid var(--accent, #8b5cf6);
  background:
    linear-gradient(color-mix(in srgb, var(--accent, #8b5cf6) 12%, transparent), transparent),
    color-mix(in srgb, var(--bg-deep, #0b1220), transparent 30%);
}
.pc-voice-bar__brand { display: flex; align-items: center; gap: 6px; min-width: 0; }
.pc-voice-bar__collapse {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
  flex-shrink: 0;
  border-radius: 6px;
  border: 1px solid var(--border, rgba(125, 211, 252, 0.22));
  background: var(--bg-3, rgba(255, 255, 255, 0.05));
  color: var(--fg-mute, #7f9bb4);
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
}
.pc-voice-bar__collapse:hover {
  color: var(--fg, #e7f7ff);
  border-color: var(--accent, #8b5cf6);
  background: color-mix(in srgb, var(--accent, #8b5cf6) 16%, transparent);
}
.pc-voice-bar__brand svg { color: var(--accent, #8b5cf6); flex-shrink: 0; }
.pc-voice-bar__title { font-size: 12px; font-weight: 800; color: var(--fg, #e7f7ff); white-space: nowrap; }
.pc-voice-bar__subtitle { font-size: 10px; font-weight: 600; color: var(--fg-mute, #7f9bb4); white-space: nowrap; }
.pc-voice-bar__controls { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
`;
