/**
 * resolveConfig persona repoint. The voice host's prod
 * dep set resolves a `humanFacingRole` from the `humanFacingRole` voice pref and
 * threads it into the ElSessionConfig — the host then sets `brainRole` from it.
 * The EL agent id / signed-URL minting is UNCHANGED; only the persona switches.
 *
 * Mocks the I/O leg (prefs, EL key, signed-URL mint, workspace id) so the test
 * exercises the pure resolution branch without a live EL endpoint.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoicePrefs } from '../voice-prefs';

let prefs: Partial<VoicePrefs>;

vi.mock('../voice-prefs', () => ({
  loadVoicePrefs: vi.fn(async () => prefs),
}));
vi.mock('../voice-credentials', () => ({
  readElevenLabsKey: vi.fn(async () => 'el-key'),
}));
vi.mock('../endpoint-route/routes/agent-mcp/operator-elevenlabs-ws-init', () => ({
  mintSignedUrlFromEL: vi.fn(async () => ({ signedUrl: 'wss://el/signed' })),
}));
vi.mock('../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-test',
}));
// The deps module side-effect-imports the full tool registry; stub it out.
vi.mock('../agent-tools/index', () => ({}));

import { createOperatorVoiceSessionDeps } from './operator-voice-session-deps';

function resolve() {
  const deps = createOperatorVoiceSessionDeps(() => {});
  return deps.resolveConfig();
}

describe('resolveConfig — humanFacingRole persona repoint (P-011)', () => {
  beforeEach(() => {
    prefs = {
      fullAgentEngine: 'elevenlabs-conv',
      elevenLabsAgentId: 'agent_123',
      agentLanguage: 'en',
    };
  });

  it('defaults humanFacingRole to operator when the pref is unset', async () => {
    const out = await resolve();
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.config.humanFacingRole).toBe('operator');
  });

  it('resolves humanFacingRole=sentinel from the pref', async () => {
    prefs.humanFacingRole = 'sentinel';
    const out = await resolve();
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.config.humanFacingRole).toBe('sentinel');
      // Same EL agent / signed URL — only the brain persona switches.
      expect(out.config.signedUrl).toBe('wss://el/signed');
    }
  });

  it('keeps operator for an explicit operator pref', async () => {
    prefs.humanFacingRole = 'operator';
    const out = await resolve();
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.config.humanFacingRole).toBe('operator');
  });
});
