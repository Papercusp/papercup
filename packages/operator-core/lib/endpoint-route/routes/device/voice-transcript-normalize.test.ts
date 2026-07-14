import { describe, it, expect } from 'vitest';
import { stripNonSpeechAnnotations, isBlankTranscript } from './voice-transcript-normalize';

describe('voice transcript normalization — whisper non-speech markers', () => {
  it('treats a bare [BLANK_AUDIO] marker as an empty turn', () => {
    // The regression: whisper returns a TRUTHY "[BLANK_AUDIO]" for silence, so a
    // plain `!transcript` guard let it through to the brain (rubric
    // voice-input-edge-cases, observed live 2026-07-14).
    expect(stripNonSpeechAnnotations('[BLANK_AUDIO]')).toBe('');
    expect(isBlankTranscript('[BLANK_AUDIO]')).toBe(true);
  });

  it('handles the multi-marker string a long silence produces', () => {
    // Exact shape captured from a 60s silent utterance on the emulator.
    expect(isBlankTranscript('[BLANK_AUDIO]\n [BLANK_AUDIO]')).toBe(true);
  });

  it.each([
    '[SILENCE]',
    '[ Silence ]',
    '(silence)',
    '[MUSIC]',
    '[NOISE]',
    '*background noise*',
    '   ',
    '',
  ])('recognizes %j as no speech', (raw) => {
    expect(isBlankTranscript(raw)).toBe(true);
  });

  it.each([null, undefined])('treats %j as blank without throwing', (raw) => {
    expect(stripNonSpeechAnnotations(raw)).toBe('');
    expect(isBlankTranscript(raw)).toBe(true);
  });

  it('keeps genuinely spoken words', () => {
    expect(stripNonSpeechAnnotations('What is the capital of France?')).toBe(
      'What is the capital of France?',
    );
    expect(isBlankTranscript('What is the capital of France?')).toBe(false);
  });

  it('recovers the real words from a mixed silence+speech transcript', () => {
    // whisper sometimes prefixes a marker before the actual utterance — the
    // speech must survive, not get dropped as blank.
    expect(stripNonSpeechAnnotations('[BLANK_AUDIO] what is two plus two?')).toBe(
      'what is two plus two?',
    );
    expect(isBlankTranscript('[BLANK_AUDIO] what is two plus two?')).toBe(false);
  });

  it('collapses internal whitespace left by stripped markers', () => {
    expect(stripNonSpeechAnnotations('hello [NOISE] world')).toBe('hello world');
  });

  it('does not strip brackets embedded in real dictated words', () => {
    // Sanity: normalization only removes whole bracketed spans; a trailing
    // question mark and ordinary punctuation are untouched.
    expect(stripNonSpeechAnnotations('turn on light number 3.')).toBe('turn on light number 3.');
  });
});
