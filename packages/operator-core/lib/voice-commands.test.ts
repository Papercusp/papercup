import { describe, expect, it } from 'vitest';
import { parseVoiceCommand } from './voice-commands';

describe('parseVoiceCommand', () => {
  it('parses "cancel"', () => {
    expect(parseVoiceCommand('cancel')).toEqual({ kind: 'cancel' });
    expect(parseVoiceCommand('CANCEL')).toEqual({ kind: 'cancel' });
    expect(parseVoiceCommand(' cancel ')).toEqual({ kind: 'cancel' });
  });

  it('treats retired operator-card verbs as freeform (dispatch/dismiss removed with the card stream, unify-agent-launches D-005)', () => {
    expect(parseVoiceCommand('dispatch')).toEqual({ kind: 'freeform', text: 'dispatch' });
    expect(parseVoiceCommand('dispatch the third one')).toEqual({ kind: 'freeform', text: 'dispatch the third one' });
    expect(parseVoiceCommand('dismiss')).toEqual({ kind: 'freeform', text: 'dismiss' });
    expect(parseVoiceCommand('dismiss third')).toEqual({ kind: 'freeform', text: 'dismiss third' });
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
