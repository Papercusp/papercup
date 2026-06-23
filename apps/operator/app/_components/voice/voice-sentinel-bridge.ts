/**
 * voice-sentinel-bridge — Phase C voice-IN for the Sentinel-as-Claude-TUI
 * (sentinel-as-claude-tui-2026-06-22). A final STT transcript is POSTed to
 * `/api/operator/sentinel-input`, which writes it into the dock's 🛡 Sentinel
 * pane (a `psu --role=sentinel` Claude-Code TUI) stdin so the local user can
 * talk to the Sentinel by voice.
 *
 * LOCAL APP USER ONLY (owner constraint): the local STT→pane pipeline, NOT the
 * P2P voice-channel system. Supersedes the old voice→operator:converse route.
 */
export async function routeVoiceToSentinelPane(text: string): Promise<boolean> {
  const t = text.trim();
  if (!t) return false;
  try {
    const res = await fetch('/api/operator/sentinel-input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: t }),
    });
    return res.ok;
  } catch {
    // Dock not reachable / offline — drop the turn rather than throw.
    return false;
  }
}
