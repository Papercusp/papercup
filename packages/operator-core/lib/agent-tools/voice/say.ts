import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { pushSentinelSay } from '../../sentinel-output-buffer';

/**
 * voice:say — the Sentinel's voice-OUT (sentinel-as-claude-tui-2026-06-22,
 * Phase D). The voice-first Sentinel (a psu/Claude-Code session) calls this to
 * speak a line ALOUD to the local app user: the text is buffered, and the
 * webview voice runtime drains it (GET /api/operator/sentinel-output) and runs
 * it through the desktop TTS.
 *
 * LOCAL APP USER ONLY (owner constraint): this is the local TTS channel, NOT the
 * P2P voice-channel system (voice:join/etc.). Capability `operator:read` matches
 * the sentinel role's `voice:* → operator:read` mapping (role-principal-caps).
 */
export default defineTool({
  name: 'voice:say',
  profile: 'engineer',
  description:
    "Speak a short line ALOUD to the local app user via the desktop's TTS (the Sentinel's voice-out). LOCAL app user only — not the P2P voice channels.",
  capability: 'operator:read',
  guidance: {
    when: `You are the voice-first Sentinel and want the user to HEAR something — call voice:say with the spoken words (short: one or two sentences). The user hears ONLY what you pass here.`,
    notWhen: `Don't speak internal tool steps, long detail, or code aloud. For multi-peer P2P voice use voice:join, not this.`,
  },
  requirePrincipal: false,
  // The voice-first Sentinel is the primary caller; operator may speak too.
  agentRoles: ['sentinel', 'operator'],
  rolesQuota: { sentinel: { perRun: 2000 }, operator: { perRun: 400 } },
  args: z.object({
    text: z.string().min(1).describe('The line to speak aloud to the local user.'),
  }),
  async handler(args) {
    await pushSentinelSay(args.text);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  },
});
