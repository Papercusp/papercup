/**
 * GET /api/agent-mcp/operator-el-spend
 *
 * Returns the current month's ElevenLabs Conv AI usage and the
 * configured cap. Used by voice-mode at session-start to refuse to
 * connect when the cap is hit. Used by the settings UI to show
 * progress.
 *
 * Response: {
 *   minutes_used: number,
 *   minutes_cap: number | null,
 *   ym: string,           // 'YYYY-MM'
 *   over_cap: boolean,
 *   pct_used: number,     // 0..1, null when no cap configured
 * }
 *
 * Degraded (table missing) → {minutes_used: 0, minutes_cap: null, …}.
 * Cap is read from voice-prefs.fullAgentMonthlyMinuteCap (0 = uncapped).
 */

import { withWorkspace } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { loadVoicePrefs } from '@/lib/voice-prefs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function currentYm(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function GET(): Promise<Response> {
  const ym = currentYm();
  const workspace = activeWorkspaceId();
  let secsUsed = 0;
  try {
    secsUsed = await withWorkspace(workspace, async (tx) => {
      const rows = await tx`
        SELECT COALESCE(SUM(duration_secs), 0)::int AS total
        FROM harness_shared.el_conv_calls
        WHERE ym = ${ym}
      `;
      return Number(rows[0]?.total ?? 0);
    });
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    if (!/relation .*el_conv_calls.* does not exist/i.test(msg)) {
      return Response.json({ ok: false, error: 'db', detail: msg.slice(0, 200) }, { status: 500 });
    }
    // Degraded: table missing.
  }

  const prefs = await loadVoicePrefs();
  const minutesCap = prefs.fullAgentMonthlyMinuteCap > 0 ? prefs.fullAgentMonthlyMinuteCap : null;
  const minutesUsed = Math.round(secsUsed / 60);
  const overCap = minutesCap !== null && minutesUsed >= minutesCap;
  const pctUsed = minutesCap !== null ? Math.min(1, minutesUsed / minutesCap) : null;

  return Response.json({
    minutes_used: minutesUsed,
    minutes_cap: minutesCap,
    ym,
    over_cap: overCap,
    pct_used: pctUsed,
  });
}
