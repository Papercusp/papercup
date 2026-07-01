/**
 * operator:credentials_status — return masked credential status for
 * every voice provider (set / not-set + masked tail). Read-only.
 *
 * Writes (storing API keys) intentionally stay on the legacy
 * /api/agent-mcp/operator-credentials PUT route. Letting agents
 * write raw third-party keys via MCP is a bigger security commitment
 * than just exposing read-status; do it via a separate principal-
 * bound built-in if/when that's actually needed.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  maskKey,
  readCartesiaKey,
  readDeepgramKey,
  readElevenLabsKey,
  readOpenAiKey,
  readPicovoiceKey,
} from '../../voice-credentials';

export default defineTool({
  name: 'operator:credentials_status',
  profile: 'engineer',
  description: 'Masked credential status for voice providers (set/not-set + tail). Read-only — never returns raw keys.',
  capability: 'secrets:operator-credentials:read',
  guidance: {
    when: `Check which API credentials (EL, OpenAI, etc.) are configured + valid. Used in onboarding + diagnostics.`,
    notWhen: `For SETTING credentials, use the /settings UI directly — agents shouldn't paste secrets.`,
    seeAlso: [
      'accounts:status (per-account credential / rate status)',
      'accounts:list (registered accounts)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({}),
  async handler() {
    const [el, openai, cartesia, deepgram, picovoice] = await Promise.all([
      readElevenLabsKey(),
      readOpenAiKey(),
      readCartesiaKey(),
      readDeepgramKey(),
      readPicovoiceKey(),
    ]);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          elevenlabs: { set: !!el, masked: maskKey(el) },
          openai: { set: !!openai, masked: maskKey(openai) },
          cartesia: { set: !!cartesia, masked: maskKey(cartesia) },
          deepgram: { set: !!deepgram, masked: maskKey(deepgram) },
          picovoice: { set: !!picovoice, masked: maskKey(picovoice) },
        }),
      }],
    };
  },
});
