/**
 * Phase 6: assert the `silence_after_question` trigger line emits the
 * Ready card instructions (single-option chat:ask_choice with
 * voiceAnswerable: true), not the legacy "say ready" plain text.
 *
 * Smoke-style: calls buildOperatorPrompt with the silence trigger and
 * inspects the assembled string. Pins the contract so a future edit
 * doesn't silently regress to the pre-Phase-6 plain-text instruction.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/voice-prefs', () => ({
  loadVoicePrefs: vi.fn(async () => ({ operatorHistoryTokenBudget: 40000 })),
}));

vi.mock('@/lib/memory/injection', () => ({
  buildMemoryContextBlock: vi.fn(async () => ''),
  lastUserContext: vi.fn(() => ''),
}));

import { buildOperatorPrompt } from './converse-prompt';

describe('silence_after_question trigger line', () => {
  it('instructs the brain to emit a chat:ask_choice Ready card with voiceAnswerable', async () => {
    const prompt = await buildOperatorPrompt(
      {
        messages: [],
        trigger: 'silence_after_question',
        modality: 'text',
        mayAskActive: false,
      },
      null,
    );
    // The trigger section must appear under the ## Trigger header.
    expect(prompt).toContain('silence_after_question');
    // Card shape signals.
    expect(prompt).toContain('chat:ask_choice');
    expect(prompt).toContain('"ready"');
    expect(prompt).toContain('voiceAnswerable');
    expect(prompt).toContain('fallbackText');
    // The legacy "two sentences" / "say ready" instruction is gone.
    expect(prompt).not.toContain('Total length: 2 sentences');
    expect(prompt).not.toContain('"When you\'re ready, just say ready."');
  });

  it('voice modality emits the same card shape (no text/voice branching)', async () => {
    const prompt = await buildOperatorPrompt(
      {
        messages: [],
        trigger: 'silence_after_question',
        modality: 'voice',
        mayAskActive: false,
      },
      null,
    );
    expect(prompt).toContain('chat:ask_choice');
    expect(prompt).toContain('voiceAnswerable');
    expect(prompt).toContain('"ready"');
  });
});
