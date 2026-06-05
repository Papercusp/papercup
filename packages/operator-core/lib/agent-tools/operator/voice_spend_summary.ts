/**
 * operator:voice_spend_summary — read-only union of voice spend trackers.
 *
 * Consolidates GET /api/agent-mcp/operator-{el,stt,tts}-spend into one
 * tool keyed by `scope`. Per-scope shapes:
 *   - 'el'  → { minutesUsed, minutesCap, ym, overCap, pctUsed }
 *             (minutes used vs. configured cap for the month)
 *   - 'stt' → SttSpendState (today's USD + soft/hard caps + session)
 *   - 'tts' → TtsSpend (per-K-char rate, today's chars + estimate, caps)
 *   - 'all' → { el, stt, tts } merged
 *
 * Writes (record stt minutes, update tts knobs) stay on the legacy
 * routes for now — separate tool when needed.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { loadVoicePrefs } from '../../voice-prefs';
import { loadSttSpend } from '../../stt-spend';
import { loadSpend as loadTtsSpend } from '../../tts-spend';

const ALL_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

function currentYm(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface ElSpend {
  minutesUsed: number;
  minutesCap: number | null;
  ym: string;
  overCap: boolean;
  pctUsed: number | null;
}

async function readElSpend(): Promise<ElSpend> {
  const ym = currentYm();
  const workspace = activeWorkspaceId();
  let secsUsed = 0;
  try {
    secsUsed = await withWorkspace(workspace, async (tx) => {
      const rows = await tx<{ total: number }[]>`
        SELECT COALESCE(SUM(duration_secs), 0)::int AS total
          FROM harness_shared.elevenlabs_conv_sessions
         WHERE workspace = ${workspace}
           AND to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM') = ${ym}
      `;
      return rows[0]?.total ?? 0;
    });
  } catch {
    // Table missing or PG unreachable → degraded zeros
    secsUsed = 0;
  }
  const minutesUsed = secsUsed / 60;
  const prefs = await loadVoicePrefs().catch(() => null);
  const cap = prefs?.fullAgentMonthlyMinuteCap;
  const minutesCap = typeof cap === 'number' && cap > 0 ? cap : null;
  return {
    minutesUsed,
    minutesCap,
    ym,
    overCap: minutesCap !== null && minutesUsed >= minutesCap,
    pctUsed: minutesCap !== null ? Math.min(1, minutesUsed / minutesCap) : null,
  };
}

export default defineTool({
  name: 'operator:voice_spend_summary',
  profile: 'engineer',
  description: 'Voice spend snapshot — el (Conv AI minutes), stt (today USD + caps), tts (per-K-char rate + caps), or all merged.',
  capability: 'operator:read',
  guidance: {
    when: `Read aggregated voice-engine spend (EL minutes, OpenAI tokens) for budget visibility.`,
    notWhen: `For operator daily budget across all surfaces, use \`operator:budget\`. voice_spend_summary is the voice slice.`,
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    scope: z.enum(['el', 'stt', 'tts', 'all']).default('all'),
  }),
  async handler(args) {
    const scope = args.scope ?? 'all';
    if (scope === 'el') {
      return { content: [{ type: 'text', text: JSON.stringify({ el: await readElSpend() }) }] };
    }
    if (scope === 'stt') {
      return { content: [{ type: 'text', text: JSON.stringify({ stt: await loadSttSpend() }) }] };
    }
    if (scope === 'tts') {
      return { content: [{ type: 'text', text: JSON.stringify({ tts: await loadTtsSpend() }) }] };
    }
    const [el, stt, tts] = await Promise.all([
      readElSpend(),
      loadSttSpend(),
      loadTtsSpend(),
    ]);
    return { content: [{ type: 'text', text: JSON.stringify({ el, stt, tts }) }] };
  },
});
