/**
 * resolvePapercupChatModel — the chat papercup role's quick-model pin ladder
 * (papercup-chat-one-component-one-contract-2026-09-06 P-005, D-007 §3).
 * Pure: env/config injected.
 */
import { describe, expect, it } from 'vitest';
import { PAPERCUP_CHAT_MODEL_PIN } from '../agent-config-constants';
import { resolvePapercupChatModel } from './papercup-chat-model';

describe('resolvePapercupChatModel', () => {
  it('pins gpt-5.6-luna:low ON codex when nothing overrides (backend travels with the pin)', () => {
    const r = resolvePapercupChatModel({ env: {}, config: { models: {}, roleBackends: {} }, fallbackBackend: 'claude-code' });
    expect(r).toEqual({ model: 'gpt-5.6-luna:low', backend: 'codex', modelSource: 'pin', backendSource: 'pin' });
    expect(PAPERCUP_CHAT_MODEL_PIN).toEqual({ model: 'gpt-5.6-luna:low', backend: 'codex' });
  });

  it('a PG-unreachable config (null) still resolves the pin', () => {
    const r = resolvePapercupChatModel({ env: {}, config: null });
    expect(r.model).toBe('gpt-5.6-luna:low');
    expect(r.backend).toBe('codex');
  });

  it('env PAPERCUP_CHAT_MODEL wins over agent-config models.papercup, which wins over the pin', () => {
    const cfg = { models: { papercup: 'sonnet[1m]:high' }, roleBackends: {} };
    expect(resolvePapercupChatModel({ env: {}, config: cfg }).modelSource).toBe('agent-config');
    expect(resolvePapercupChatModel({ env: {}, config: cfg }).model).toBe('sonnet[1m]:high');
    const r = resolvePapercupChatModel({ env: { PAPERCUP_CHAT_MODEL: ' opus:high ' }, config: cfg });
    expect(r.model).toBe('opus:high');
    expect(r.modelSource).toBe('env');
  });

  it('an INFORMED model override does NOT drag the codex pin along — it runs on the operator surface backend', () => {
    // WI-4623 in reverse: an owner who sets a Claude model must not have it
    // handed to the codex CLI just because the pin's backend was codex.
    const r = resolvePapercupChatModel({
      env: { PAPERCUP_CHAT_MODEL: 'sonnet[1m]:high' },
      config: { models: {}, roleBackends: {} },
      fallbackBackend: 'claude-code',
    });
    expect(r.backend).toBe('claude-code');
    expect(r.backendSource).toBe('surface');
    // ...and inherits the process-global backend when there is no surface override.
    const inherit = resolvePapercupChatModel({ env: { PAPERCUP_CHAT_MODEL: 'sonnet[1m]:high' }, config: null });
    expect(inherit.backend).toBeUndefined();
    expect(inherit.backendSource).toBe('inherit');
  });

  it('env PAPERCUP_CHAT_BACKEND > agent-config roleBackends.papercup > pin; an unknown backend is ignored', () => {
    const cfg = { models: {}, roleBackends: { papercup: 'omp' as const } };
    expect(resolvePapercupChatModel({ env: {}, config: cfg }).backend).toBe('omp');
    expect(resolvePapercupChatModel({ env: {}, config: cfg }).backendSource).toBe('agent-config');
    const env = resolvePapercupChatModel({ env: { PAPERCUP_CHAT_BACKEND: 'claude-code' }, config: cfg });
    expect(env.backend).toBe('claude-code');
    expect(env.backendSource).toBe('env');
    const bogus = resolvePapercupChatModel({ env: { PAPERCUP_CHAT_BACKEND: 'gemini' }, config: { models: {}, roleBackends: {} } });
    expect(bogus.backend).toBe('codex');
    expect(bogus.backendSource).toBe('pin');
  });
});
