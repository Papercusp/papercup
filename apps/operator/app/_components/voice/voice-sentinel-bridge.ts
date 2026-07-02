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

/**
 * Phase D voice-OUT: drain the Sentinel spoken-line FIFO in local mode. The
 * webview polls this while voice is active and no full-agent session owns the
 * shared voice path. The buffer is filled by the Sentinel calling `voice:say`.
 */
export async function drainSentinelOutput(): Promise<string[]> {
  try {
    const res = await fetch('/api/operator/sentinel-output', { method: 'GET' });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => null)) as { says?: unknown } | null;
    return Array.isArray(data?.says)
      ? data.says.filter((s): s is string => typeof s === 'string')
      : [];
  } catch {
    return [];
  }
}
