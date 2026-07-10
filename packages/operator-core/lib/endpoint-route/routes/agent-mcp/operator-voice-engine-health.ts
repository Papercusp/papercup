/**
 * GET /api/agent-mcp/operator-voice-engine-health — live engine reachability
 * probe for the settings "Re-detect engines" button (WI-3663).
 *
 * The button used to be a no-op: it only re-fetched prefs and toasted, and its
 * comment referenced the client `voice-engines.ts` detection cache that was
 * DELETED with the dead adapter framework (WI-3448). This route makes "re-detect"
 * mean something: it actually probes the two LOCAL engines for reachability
 * (kokoro TTS on :8880, voicemode Whisper STT on :2022) and reports which cloud
 * providers have a key configured — all server-side, so no key reaches the
 * browser. `auth: 'loopback'`.
 *
 * Local probes run concurrently (each ~2s-capped); a down engine reads `false`,
 * never throws.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { readElevenLabsKey, readOpenAiKey, readCartesiaKey } from '../../../voice-credentials';
import { probeKokoroHealth, probeVoicemodeHealth } from './operator-voice-proxy-helpers';

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-voice-engine-health',
  auth: 'loopback',
  async handler() {
    const [kokoro, voicemode, elKey, oaKey, caKey] = await Promise.all([
      probeKokoroHealth(),
      probeVoicemodeHealth(),
      readElevenLabsKey().then((k) => !!k).catch(() => false),
      readOpenAiKey().then((k) => !!k).catch(() => false),
      readCartesiaKey().then((k) => !!k).catch(() => false),
    ]);
    return Response.json({
      // Local engines: LIVE reachability (probed just now).
      kokoro,      // local TTS (:8880)
      voicemode,   // local Whisper STT (:2022)
      // Cloud engines: key CONFIGURED (reachability is only tested on explicit "Test connection").
      elevenlabs: elKey,
      openai: oaKey,
      cartesia: caKey,
      probedAt: Date.now(),
    });
  },
});
