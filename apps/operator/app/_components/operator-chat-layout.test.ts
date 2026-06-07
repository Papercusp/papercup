// @vitest-environment node
/**
 * operator-chat-layout — the chat-panel width clamp math.
 *
 * Covers `operatorChatWidthCeiling` (75% of viewport, floored, never below
 * the collapsed-rail width), `clampOperatorChatWidth` (non-finite → default,
 * min/max clamping — note MIN === the 56px collapsed rail, deliberately not
 * the old 360 floor), and `operatorChatOffsetWidth` (closed → collapsed
 * width; open → clamped). Pure functions — node env.
 */

import { describe, expect, it } from 'vitest';
import {
  OPERATOR_CHAT_COLLAPSED_WIDTH,
  OPERATOR_CHAT_DEFAULT_WIDTH,
  OPERATOR_CHAT_MIN_WIDTH,
  clampOperatorChatWidth,
  operatorChatOffsetWidth,
  operatorChatWidthCeiling,
} from './operator-chat-layout';

describe('operatorChatWidthCeiling', () => {
  it('is 75% of the viewport, floored', () => {
    expect(operatorChatWidthCeiling(1000)).toBe(750);
    expect(operatorChatWidthCeiling(1001)).toBe(750); // floor(750.75)
  });

  it('never drops below the collapsed-rail width', () => {
    expect(operatorChatWidthCeiling(0)).toBe(OPERATOR_CHAT_MIN_WIDTH);
    expect(operatorChatWidthCeiling(40)).toBe(OPERATOR_CHAT_MIN_WIDTH);
  });
});

describe('clampOperatorChatWidth', () => {
  it('returns the default for non-finite widths', () => {
    expect(clampOperatorChatWidth(Number.NaN, 1200)).toBe(OPERATOR_CHAT_DEFAULT_WIDTH);
    expect(clampOperatorChatWidth(Number.POSITIVE_INFINITY, 1200)).toBe(OPERATOR_CHAT_DEFAULT_WIDTH);
  });

  it('floors at the collapsed-rail width (the deliberate post-360 minimum)', () => {
    expect(OPERATOR_CHAT_MIN_WIDTH).toBe(OPERATOR_CHAT_COLLAPSED_WIDTH);
    expect(clampOperatorChatWidth(10, 1200)).toBe(OPERATOR_CHAT_MIN_WIDTH);
  });

  it('caps at the viewport ceiling', () => {
    expect(clampOperatorChatWidth(5000, 1200)).toBe(900);
  });

  it('passes an in-range width through', () => {
    expect(clampOperatorChatWidth(400, 1200)).toBe(400);
  });
});

describe('operatorChatOffsetWidth', () => {
  it('uses the collapsed width when closed, regardless of the stored width', () => {
    expect(operatorChatOffsetWidth(false, 700, 1200)).toBe(OPERATOR_CHAT_COLLAPSED_WIDTH);
  });

  it('clamps the stored width when open', () => {
    expect(operatorChatOffsetWidth(true, 700, 1200)).toBe(700);
    expect(operatorChatOffsetWidth(true, 5000, 1200)).toBe(900);
    expect(operatorChatOffsetWidth(true, Number.NaN, 1200)).toBe(OPERATOR_CHAT_DEFAULT_WIDTH);
  });
});
