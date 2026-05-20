/**
 * GET /api/desktop/voice-configured — whether voice is configured
 * (ElevenLabs key set) or the user has opted into voice. Never returns
 * the key itself.
 *
 * Ported from app/api/desktop/voice-configured/route.ts. `auth: {}`.
 */
import { readElevenLabsKey } from '@/lib/voice-credentials';
import { readOperatorState } from '@/lib/operator-state-pg';
import { defineRoute } from '../../define-route';

export default defineRoute({
  method: 'GET',
  path: '/desktop/voice-configured',
  auth: {},
  async handler() {
    try {
      const [key, state] = await Promise.all([
        readElevenLabsKey(),
        readOperatorState<{ voice_intent?: boolean }>('setup_wizard_state'),
      ]);
      const configured = Boolean(key);
      const intent = Boolean(state?.voice_intent);
      return Response.json({ configured, intent });
    } catch {
      return Response.json({ configured: false, intent: false });
    }
  },
});
