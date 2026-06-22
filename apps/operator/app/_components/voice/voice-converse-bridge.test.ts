/**
 * voice-converse-bridge — the Phase 1 seam that routes a spoken voice turn into
 * the operator:converse / Sentinel brain (sentinel-tui-shared-backend §6, Voice
 * domain in /admin/testing). Verifies the contract VoiceAppBridge relies on:
 *   - a registered handler receives the transcript with `spoken:true` (so the
 *     provider speaks the assistant reply),
 *   - with NO provider mounted the turn is dropped (returns false) rather than
 *     reviving a dead backend (the old Oracle leg).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setVoiceConverseHandler, routeVoiceUtteranceToConverse } from './voice-converse-bridge';

afterEach(() => setVoiceConverseHandler(null));

describe('voice-converse-bridge', () => {
  it('routes a spoken utterance to the registered handler, flagged spoken:true', () => {
    const handler = vi.fn();
    setVoiceConverseHandler(handler);
    const routed = routeVoiceUtteranceToConverse('what is the status of the build');
    expect(routed).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('what is the status of the build', { spoken: true });
  });

  it('drops the turn (returns false) when no conversation provider is mounted', () => {
    setVoiceConverseHandler(null);
    expect(routeVoiceUtteranceToConverse('hello')).toBe(false);
  });

  it('stops routing after the provider unmounts (handler cleared)', () => {
    const handler = vi.fn();
    setVoiceConverseHandler(handler);
    setVoiceConverseHandler(null); // provider unmount
    expect(routeVoiceUtteranceToConverse('hi')).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
