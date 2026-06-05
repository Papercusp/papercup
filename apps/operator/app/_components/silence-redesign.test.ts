/**
 * Unit tests for the 2026-05-11 silence-redesign helpers:
 *   - detectAwaitingReply: gates the single-nudge timer
 *   - detectUserReadyTrigger: routes "ready"-style utterances to the
 *     user_says_ready trigger so the operator returns suggestions
 */

import { describe, it, expect } from 'vitest';
import {
  detectAwaitingReply,
  detectUserReadyTrigger,
} from './OperatorConversationProvider';

describe('detectAwaitingReply', () => {
  it('returns true when text ends with ?', () => {
    expect(detectAwaitingReply('Want me to dispatch?')).toBe(true);
  });

  it('returns true with trailing markdown asterisks', () => {
    expect(detectAwaitingReply('Want me to *dispatch*?**')).toBe(true);
  });

  it('returns false when text is a statement', () => {
    expect(detectAwaitingReply('Sheets has 3 escalations.')).toBe(false);
  });

  it('returns false when text is null or empty', () => {
    expect(detectAwaitingReply(null)).toBe(false);
    expect(detectAwaitingReply(undefined)).toBe(false);
    expect(detectAwaitingReply('')).toBe(false);
  });

  it('returns true when tools include chat:ask_choice (even if say has no ?)', () => {
    expect(detectAwaitingReply('Pick one:', [{ name: 'chat:ask_choice' }])).toBe(true);
    expect(detectAwaitingReply(null, [{ name: 'chat:ask_choice' }])).toBe(true);
  });

  it('returns false for unrelated tool calls', () => {
    expect(detectAwaitingReply('Done.', [{ name: 'tasks:create' }])).toBe(false);
  });
});

describe('detectUserReadyTrigger', () => {
  it('matches bare "ready"', () => {
    expect(detectUserReadyTrigger('ready')).toBe(true);
    expect(detectUserReadyTrigger('Ready')).toBe(true);
    expect(detectUserReadyTrigger('ready.')).toBe(true);
  });

  it('matches "next" / "go" / "continue"', () => {
    expect(detectUserReadyTrigger('next')).toBe(true);
    expect(detectUserReadyTrigger('go')).toBe(true);
    expect(detectUserReadyTrigger('continue')).toBe(true);
    expect(detectUserReadyTrigger("let's go")).toBe(true);
    expect(detectUserReadyTrigger('keep going')).toBe(true);
  });

  it('matches "what now" / "what should I do"', () => {
    expect(detectUserReadyTrigger('what now?')).toBe(true);
    expect(detectUserReadyTrigger("what's next?")).toBe(true);
    expect(detectUserReadyTrigger('what should I do next?')).toBe(true);
    expect(detectUserReadyTrigger('what should I work on?')).toBe(true);
  });

  it('does NOT match longer substantive messages', () => {
    expect(detectUserReadyTrigger("ready to ship the marketplace pipeline")).toBe(false);
    expect(detectUserReadyTrigger("I'm not ready")).toBe(false);
    expect(detectUserReadyTrigger("next time we should X")).toBe(false);
    expect(detectUserReadyTrigger("go ahead and start")).toBe(false);
  });

  it('does NOT match unrelated utterances', () => {
    expect(detectUserReadyTrigger('hello')).toBe(false);
    expect(detectUserReadyTrigger('what is the status of sheets')).toBe(false);
  });
});
