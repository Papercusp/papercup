/**
 * voice-sentinel-bridge — the PRIMARY voice-IN route (voice-public-release-
 * readiness-2026-07-12 P-019/D-004/D-007). A final STT transcript is POSTed to
 * `/api/operator/papercup-input`, which writes it into the dock's Papercup
 * pane (a `psu --role=papercup` Claude-Code TUI — the persistent fast
 * front-end) so the user talks to Papercup by voice. The dock ships on ALL
 * platforms (D-004); when the pane route is unavailable (503: no dock / no
 * registered pane) the caller (VoiceAppBridge) falls back to the in-process
 * converse brain via submitVoiceTurn.
 *
 * LOCAL APP USER ONLY (owner constraint): the local STT→pane pipeline, NOT the
 * P2P voice-channel system.
 */
export async function routeVoiceToSentinelPane(text: string): Promise<boolean> {
  const t = text.trim();
  if (!t) return false;
  try {
    const res = await fetch('/api/operator/papercup-input', {
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
    const res = await fetch('/api/operator/papercup-output', { method: 'GET' });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => null)) as { says?: unknown } | null;
    return Array.isArray(data?.says)
      ? data.says.filter((s): s is string => typeof s === 'string')
      : [];
  } catch {
    return [];
  }
}
