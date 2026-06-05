import { describe, expect, it } from 'vitest';
import { parseVoiceCommand } from './voice-commands';

describe('parseVoiceCommand', () => {
  it('parses "cancel"', () => {
    expect(parseVoiceCommand('cancel')).toEqual({ kind: 'cancel' });
    expect(parseVoiceCommand('CANCEL')).toEqual({ kind: 'cancel' });
    expect(parseVoiceCommand(' cancel ')).toEqual({ kind: 'cancel' });
  });

  it('parses "dispatch" (no ordinal)', () => {
    expect(parseVoiceCommand('dispatch')).toEqual({ kind: 'dispatch', ordinal: undefined });
  });

  it('parses "dispatch <ordinal>" with words', () => {
    expect(parseVoiceCommand('dispatch first')).toEqual({ kind: 'dispatch', ordinal: 1 });
    expect(parseVoiceCommand('dispatch third')).toEqual({ kind: 'dispatch', ordinal: 3 });
    expect(parseVoiceCommand('dispatch tenth')).toEqual({ kind: 'dispatch', ordinal: 10 });
  });

  it('parses "dispatch <ordinal>" with digits', () => {
    expect(parseVoiceCommand('dispatch 1')).toEqual({ kind: 'dispatch', ordinal: 1 });
    expect(parseVoiceCommand('dispatch 7')).toEqual({ kind: 'dispatch', ordinal: 7 });
  });

  it('handles "dispatch the third one" filler', () => {
    expect(parseVoiceCommand('dispatch the third one')).toEqual({ kind: 'dispatch', ordinal: 3 });
    expect(parseVoiceCommand('dispatch the second')).toEqual({ kind: 'dispatch', ordinal: 2 });
  });

  it('parses "dismiss" with and without ordinals', () => {
    expect(parseVoiceCommand('dismiss')).toEqual({ kind: 'dismiss', ordinal: undefined });
    expect(parseVoiceCommand('dismiss third')).toEqual({ kind: 'dismiss', ordinal: 3 });
    expect(parseVoiceCommand('dismiss the fifth one')).toEqual({ kind: 'dismiss', ordinal: 5 });
  });

  it('parses pause / resume / unpause', () => {
    expect(parseVoiceCommand('pause')).toEqual({ kind: 'pause' });
    expect(parseVoiceCommand('resume')).toEqual({ kind: 'resume' });
    expect(parseVoiceCommand('unpause')).toEqual({ kind: 'resume' });
  });

  it('parses scan variants', () => {
    expect(parseVoiceCommand('scan')).toEqual({ kind: 'scan' });
    expect(parseVoiceCommand('rescan')).toEqual({ kind: 'scan' });
    expect(parseVoiceCommand('re-scan')).toEqual({ kind: 'scan' });
    expect(parseVoiceCommand('scan again')).toEqual({ kind: 'scan' });
  });

  it('parses scan with query', () => {
    expect(parseVoiceCommand('scan tell me about the auth project')).toEqual({
      kind: 'scan',
      query: 'tell me about the auth project',
    });
  });

  it('falls through to freeform for unrelated text ≥2 chars', () => {
    expect(parseVoiceCommand('hello there')).toEqual({ kind: 'freeform', text: 'hello there' });
    expect(parseVoiceCommand('what time is it')).toEqual({ kind: 'freeform', text: 'what time is it' });
  });

  it('falls through to freeform for too-short text', () => {
    expect(parseVoiceCommand('a')).toEqual({ kind: 'freeform', text: 'a' });
    expect(parseVoiceCommand('')).toEqual({ kind: 'freeform', text: '' });
  });

  it('does not match approve (handled by voice-intents at chrome layer)', () => {
    expect(parseVoiceCommand('approve foo')).toEqual({ kind: 'freeform', text: 'approve foo' });
  });

  it('does not collapse "dispatch" inside larger sentences', () => {
    // "we should dispatch this" → freeform, not dispatch
    expect(parseVoiceCommand('we should dispatch this')).toEqual({
      kind: 'freeform', text: 'we should dispatch this',
    });
  });
});
